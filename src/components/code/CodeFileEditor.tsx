/**
 * The single code surface for the Code tab — used in BOTH read and edit mode so
 * the rendering is pixel-identical and only behavior changes:
 *
 * - `editable=false` (view mode): read-only. Selecting text reports the
 *   selection up via `onSelectionChange` so the parent can show the
 *   "send to agent" popover.
 * - `editable=true` (edit mode): live editing; ⌘S (or the Save button) saves.
 *
 * Because both modes render the same CodeMirror with the same theme, toggling
 * Edit never changes the font, gutter, colors, or layout.
 *
 * Controlled via `value`/`onChange`. The editable state is swapped through a
 * Compartment (no remount, so scroll position survives toggling). `revealLine`
 * scrolls to and briefly highlights a line (jump-to-code).
 */

import { useEffect, useRef } from 'react';
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit, bracketMatching } from '@codemirror/language';
import {
  ghDarkExtension,
  neutralizeInvalidHighlight,
  ssEditorTheme,
  codeTabEditorTheme,
  codeLanguageExtension,
} from '../../lib/codemirror';

export interface EditorSelectionInfo {
  text: string;
  startLine: number;
  endLine: number;
  /** Viewport coords of the selection end — anchors the parent's popover. */
  mouseX: number;
  mouseY: number;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Shiki language id from `read_project_file` (drives grammar selection). */
  language: string;
  /** false → read-only view mode (select-to-agent); true → live editing. */
  editable: boolean;
  onSave?: () => void;
  /** 1-based line to scroll to + briefly highlight (jump-to-code). */
  revealLine?: number | null;
  /** Fires with the current text selection in view mode (null when empty/editing). */
  onSelectionChange?: (sel: EditorSelectionInfo | null) => void;
}

// Transient line highlight for jump-to-code reveal.
const setRevealLine = StateEffect.define<number | null>();
const revealLineDeco = Decoration.line({ class: 'cm-reveal-line' });
const revealLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setRevealLine)) {
        if (e.value == null || e.value < 1) return Decoration.none;
        const lineNo = Math.min(e.value, tr.state.doc.lines);
        return Decoration.set([revealLineDeco.range(tr.state.doc.line(lineNo).from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function CodeFileEditor({
  value,
  onChange,
  language,
  editable,
  onSave,
  revealLine,
  onSelectionChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep listeners pointed at the latest callbacks/state without recreating the view.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const editableComp = useRef(new Compartment());
  // The last doc string we emitted via onChange. Lets the value-sync effect skip
  // re-stringifying the whole document on every keystroke (our own echo).
  const lastReportedRef = useRef(value);

  // Mount the editor. Recreated only when the grammar changes (a different file's
  // language); the doc, editability, and reveal all flow through effects below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        drawSelection(),
        history(),
        bracketMatching(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        revealLineField,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              // Save only in edit mode; let the keystroke fall through in read-only.
              if (!editableRef.current || !onSaveRef.current) return false;
              onSaveRef.current();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        codeLanguageExtension(language),
        ghDarkExtension,
        neutralizeInvalidHighlight,
        ssEditorTheme,
        codeTabEditorTheme,
        editableComp.current.of([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
        // Read-mode select-to-agent popover is positioned at fixed coords captured
        // at selection time; dismiss it on scroll so it can't float over unrelated
        // code once the selection scrolls away.
        EditorView.domEventHandlers({
          scroll() {
            if (!editableRef.current) onSelRef.current?.(null);
            return false;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const next = u.state.doc.toString();
            lastReportedRef.current = next;
            onChangeRef.current(next);
          }
          if (!u.selectionSet && !u.docChanged) return;
          // Report selections only in read-only mode — that's the select-to-agent
          // flow. In edit mode the selection is for editing, not for the popover.
          const cb = onSelRef.current;
          if (!cb) return;
          if (editableRef.current) {
            cb(null);
            return;
          }
          const sel = u.state.selection.main;
          if (sel.empty) {
            cb(null);
            return;
          }
          const doc = u.state.doc;
          // coordsAtPos is null when the position is scrolled out of view; fall
          // back to the other end, then to the editor's own rect, so the popover
          // never anchors to (0,0).
          const coords = u.view.coordsAtPos(sel.to) ?? u.view.coordsAtPos(sel.from);
          const rect = u.view.scrollDOM.getBoundingClientRect();
          cb({
            text: u.state.sliceDoc(sel.from, sel.to),
            startLine: doc.lineAt(sel.from).number,
            endLine: doc.lineAt(sel.to).number,
            mouseX: coords ? coords.left : rect.left + rect.width / 2,
            mouseY: coords ? coords.bottom : rect.top + rect.height / 2,
          });
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (editable) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `value`/`editable` are seeded once; their updates flow through the effects
    // below. Only the grammar warrants a full rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // External value changes (a save committed the buffer, or the file reloaded) →
  // replace the doc without losing the editor instance. Skip the common case
  // where `value` is just the echo of our own onChange — comparing avoids
  // stringifying the whole document on every keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === lastReportedRef.current) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // Swap editability in place (no remount → scroll position survives toggling).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableComp.current.reconfigure([
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
      ]),
    });
    if (editable) view.focus();
    else onSelRef.current?.(null);
  }, [editable]);

  // Jump-to-code: scroll the target line into view and briefly highlight it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || revealLine == null) return;
    const lineNo = Math.min(Math.max(revealLine, 1), view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      effects: [setRevealLine.of(revealLine), EditorView.scrollIntoView(pos, { y: 'center' })],
    });
    const t = setTimeout(() => {
      viewRef.current?.dispatch({ effects: setRevealLine.of(null) });
    }, 2000);
    return () => clearTimeout(t);
  }, [revealLine]);

  return <div ref={hostRef} className="code-file-editor" />;
}
