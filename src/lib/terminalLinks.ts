/**
 * Clickable web links for xterm terminals.
 *
 * Makes plain-text URLs (e.g. a dev server printing http://localhost:3000)
 * clickable. OSC 8 explicit hyperlinks already work via xterm's built-in
 * support; this covers everything that isn't emitted as a hyperlink escape.
 * Links open in the system browser via the Tauri opener plugin.
 *
 * This is a custom link provider rather than `@xterm/addon-web-links`
 * because the stock addon only joins rows the terminal soft-wrapped
 * (`line.isWrapped`). Programs that wrap their own output — Claude Code's
 * TUI hard-wraps at the terminal width and writes real newlines, indenting
 * continuation rows — produce URLs split across independent buffer lines,
 * which the addon matches as a dead truncated link on the first row only.
 * We additionally treat a row whose content reaches the last few columns
 * as wrapping onto the next row ("inferred wrap" — programs keep small
 * right margins, so "full" is a zone, not one column): a URL only breaks
 * mid-token when the wrapper hard-breaks at its width, so a near-full row
 * is the signature of that break. A token-length guard (see
 * computeMultilineLinks) rejects joins a word-wrapper wouldn't have made.
 *
 * The URL regex and `isUrl` validation are adapted from
 * `@xterm/addon-web-links` (MIT, © The xterm.js authors).
 *
 * @module lib/terminalLinks
 */

import type { ILink, ITerminalAddon, IDisposable, Terminal } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { logger } from './logger';

// Matches http(s) URLs up to the first whitespace/quote, excluding trailing
// interpunction and brackets. Copied from @xterm/addon-web-links (MIT).
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

/** Hard cap on the joined multi-row string, mirroring the stock addon. */
const MAX_JOINED_LENGTH = 2048;
/** Most continuation rows we'll chain through inferred (hard) wraps. */
const MAX_INFERRED_ROWS = 8;
/** Max leading spaces a hard-wrapped continuation row may carry (Claude
 *  Code indents continuations by 2; give a little headroom). */
const MAX_CONTINUATION_INDENT = 4;

/** Structural subset of xterm's IBufferCell, for testability. */
export interface LinkableCell {
  getChars(): string;
  getWidth(): number;
}

/** Structural subset of xterm's IBufferLine, for testability. */
export interface LinkableLine {
  isWrapped: boolean;
  length: number;
  translateToString(trimRight: boolean): string;
  getCell(x: number): LinkableCell | undefined;
}

/** Structural subset of xterm's IBuffer, for testability. */
export interface LinkableBuffer {
  getLine(y: number): LinkableLine | undefined;
}

/** A computed link: the full URL text plus its 1-based inclusive range. */
export interface ComputedLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
}

/** One buffer row's contribution to the joined string. */
interface Segment {
  /** Absolute buffer row index (0-based). */
  row: number;
  /** Leading space cells stripped from a hard-wrapped continuation row. */
  indent: number;
  /** True when this row was joined via inferred (hard) wrap rather than a
   *  terminal soft wrap — matches crossing into it get the token guard. */
  inferred: boolean;
  /** Row content with trailing blanks (and the indent) removed. */
  text: string;
}

// Adapted from @xterm/addon-web-links (MIT): a match must reparse as a real
// URL whose origin prefixes the matched text, so "https://x" garbage from
// surrounding characters doesn't become a link.
function isUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return urlString.toLocaleLowerCase().startsWith(parsedBase.toLocaleLowerCase());
  } catch {
    return false;
  }
}

/** Trimmed row content, or null when the row doesn't exist. */
function rowText(buffer: LinkableBuffer, row: number): string | null {
  const line = buffer.getLine(row);
  return line ? line.translateToString(true) : null;
}

/** Programs wrap a few columns short of the edge (right margins, hanging
 *  gutters — Claude Code's TUI leaves several). The "wrap zone" is how far
 *  from the last column a row may end and still count as width-forced.
 *  Proportional at small widths so a half-empty row never counts. */
function wrapZone(cols: number): number {
  return Math.min(6, Math.max(2, Math.floor(cols / 8)));
}

/** A row whose content reaches into the wrap zone was (very likely)
 *  force-broken by width — the program, not the terminal, wrapped there.
 *  The token-length guard in computeMultilineLinks backstops the cases
 *  where word-wrapped prose happens to end in the zone. */
function rowIsFull(buffer: LinkableBuffer, row: number, cols: number): boolean {
  const text = rowText(buffer, row);
  return text !== null && text.length >= cols - wrapZone(cols);
}

/**
 * How `row` continues the row above it, if at all:
 * - terminal soft wrap (`isWrapped`) → certain, no indent;
 * - inferred hard wrap (previous row reaches the wrap zone, this row's
 *   leading indent small) → indent = leading spaces to strip;
 * - otherwise null.
 */
function continuationInfo(
  buffer: LinkableBuffer,
  row: number,
  cols: number
): { indent: number; inferred: boolean } | null {
  const line = buffer.getLine(row);
  if (!line) return null;
  if (line.isWrapped) return { indent: 0, inferred: false };
  if (row === 0 || !rowIsFull(buffer, row - 1, cols)) return null;
  const text = line.translateToString(true);
  const indent = text.length - text.trimStart().length;
  if (text.length === 0 || indent > MAX_CONTINUATION_INDENT) return null;
  return { indent, inferred: true };
}

function segmentFor(
  buffer: LinkableBuffer,
  row: number,
  indent: number,
  inferred: boolean
): Segment {
  const text = rowText(buffer, row) ?? '';
  return { row, indent, inferred, text: text.slice(indent) };
}

/**
 * Collect the window of rows that could hold a URL overlapping `rowIdx`,
 * walking soft AND inferred wraps in both directions. Like the stock addon,
 * expansion stops after a row containing a space — a URL can't continue
 * past it — which keeps windows tiny on dense TUI output.
 */
function buildWindow(buffer: LinkableBuffer, rowIdx: number, cols: number): Segment[] {
  if (!buffer.getLine(rowIdx)) return [];

  // Ascend to the top of the chain.
  let top = rowIdx;
  let inferredSteps = 0;
  let length = rowText(buffer, rowIdx)?.length ?? 0;
  while (top > 0 && length < MAX_JOINED_LENGTH && inferredSteps < MAX_INFERRED_ROWS) {
    const info = continuationInfo(buffer, top, cols);
    if (info === null) break;
    if (info.inferred) inferredSteps++;
    top--;
    const text = rowText(buffer, top) ?? '';
    length += text.length;
    // The row above holds at most the start of the URL — include it, stop.
    if (text.includes(' ')) break;
  }

  // Descend from the top, building segments while rows keep continuing.
  const segments: Segment[] = [segmentFor(buffer, top, 0, false)];
  let row = top;
  inferredSteps = 0;
  length = segments[0].text.length;
  while (length < MAX_JOINED_LENGTH && inferredSteps < MAX_INFERRED_ROWS) {
    const info = continuationInfo(buffer, row + 1, cols);
    if (info === null) break;
    if (info.inferred) inferredSteps++;
    row++;
    const seg = segmentFor(buffer, row, info.indent, info.inferred);
    segments.push(seg);
    length += seg.text.length;
    // A space below the clicked row ends any URL passing through it.
    if (row >= rowIdx && seg.text.includes(' ')) break;
  }

  // The clicked row must be inside the window (it always is — top ≤ rowIdx
  // by construction and we descend at least back to it via continuations).
  return row >= rowIdx ? segments : [];
}

/**
 * Map an index in the joined string back to its buffer cell. Walks cells
 * per segment (starting past the stripped indent) so wide chars and
 * trimmed rows stay aligned. Returns null if the index falls outside the
 * window (shouldn't happen for regex matches over the joined string).
 */
function mapIndex(
  buffer: LinkableBuffer,
  segments: Segment[],
  index: number
): { row: number; col: number; width: number } | null {
  let offset = 0;
  for (const seg of segments) {
    if (index >= offset + seg.text.length) {
      offset += seg.text.length;
      continue;
    }
    const line = buffer.getLine(seg.row);
    if (!line) return null;
    let local = index - offset;
    for (let col = seg.indent; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell) return null;
      const width = cell.getWidth();
      if (width === 0) continue; // right half of a wide char
      const consumed = cell.getChars().length || 1;
      if (local < consumed) return { row: seg.row, col, width };
      local -= consumed;
    }
    return null;
  }
  return null;
}

/**
 * Compute all links overlapping buffer row `rowIdx` (0-based). Exported for
 * tests; the provider below adapts this to xterm's ILinkProvider.
 */
export function computeMultilineLinks(
  buffer: LinkableBuffer,
  rowIdx: number,
  cols: number
): ComputedLink[] {
  const segments = buildWindow(buffer, rowIdx, cols);
  if (segments.length === 0) return [];
  const joined = segments.map((s) => s.text).join('');

  const rex = new RegExp(URL_REGEX.source, 'g');
  const links: ComputedLink[] = [];
  let match: RegExpExecArray | null;
  while ((match = rex.exec(joined))) {
    let text = match[0];
    // Token guard for inferred joins: a word-wrapper only splits a token
    // mid-way when the token wouldn't fit on a line by itself. If the joined
    // token is no longer than the row it supposedly broke on, the
    // "continuation" is really the next word of word-wrapped prose — clamp
    // the match back to that boundary.
    let cum = 0;
    for (let k = 0; k < segments.length - 1; k++) {
      cum += segments[k].text.length;
      if (cum <= match.index) continue; // boundary before the match
      if (cum >= match.index + text.length) break; // match ends at/before it
      if (!segments[k + 1].inferred) continue; // soft wrap — certain
      const rowLen = rowText(buffer, segments[k].row)?.length ?? 0;
      if (text.length > rowLen) continue; // genuine width-forced split
      const clipped = new RegExp(URL_REGEX.source).exec(text.slice(0, cum - match.index));
      text = clipped && clipped.index === 0 ? clipped[0] : '';
      break;
    }
    if (!text || !isUrl(text)) continue;
    const start = mapIndex(buffer, segments, match.index);
    const end = mapIndex(buffer, segments, match.index + text.length - 1);
    if (!start || !end) continue;
    links.push({
      text,
      // 1-based, end-inclusive (wide end glyphs covered via cell width).
      range: {
        start: { x: start.col + 1, y: start.row + 1 },
        end: { x: end.col + end.width, y: end.row + 1 },
      },
    });
  }
  return links;
}

class MultilineWebLinksAddon implements ITerminalAddon {
  private _provider: IDisposable | undefined;

  public activate(terminal: Terminal): void {
    this._provider = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) => {
        const computed = computeMultilineLinks(
          terminal.buffer.active,
          bufferLineNumber - 1,
          terminal.cols
        );
        callback(
          computed.map(
            (link): ILink => ({
              text: link.text,
              range: link.range,
              activate: (_event, uri) => {
                openUrl(uri).catch((err: unknown) => {
                  logger.warn('[terminalLinks] Failed to open link', {
                    uri,
                    error: String(err),
                  });
                });
              },
            })
          )
        );
      },
    });
  }

  public dispose(): void {
    this._provider?.dispose();
  }
}

/** Create the web-links addon that opens links in the system browser. */
export function createWebLinksAddon(): ITerminalAddon {
  return new MultilineWebLinksAddon();
}
