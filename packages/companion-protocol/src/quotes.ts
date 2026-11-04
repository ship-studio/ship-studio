/**
 * Quotes, as both clients write and read them: each quoted passage a `> `
 * blockquote ahead of what was typed. Pure, and shared so the desk and the
 * phone can never disagree about the format.
 */

/** Selected text as a Markdown quote, ready for the composer. */
export function quoteText(text: string): string {
  const lines = text
    .trim()
    .replace(/\n{3,}/g, '\n\n')
    .split('\n');
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n') + '\n\n';
}

/** What's sent: each quoted passage as a blockquote, then what was typed. */
export function withQuotes(quotes: string[], text: string): string {
  return (quotes.map(quoteText).join('') + text).trim();
}

/** A user message split into its quoted passages and its own words. */
export interface BubblePart {
  kind: 'quote' | 'text';
  text: string;
}

/**
 * Only `>` blockquotes are read out of a user's message; everything else
 * stays the literal text they typed.
 */
export function splitQuotes(text: string): BubblePart[] {
  const parts: BubblePart[] = [];
  let lines: string[] = [];
  let kind: BubblePart['kind'] = 'text';
  const flush = () => {
    const body = lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (body.trim()) parts.push({ kind, text: body });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const quoted = /^>\s?/.test(line);
    const next = quoted ? 'quote' : 'text';
    if (next !== kind) {
      flush();
      kind = next;
    }
    lines.push(quoted ? line.replace(/^>\s?/, '') : line);
  }
  flush();
  return parts;
}
