/**
 * A real code editor (CodeMirror 6) used by the element HTML editor and the
 * CSS-mode Code view: syntax highlighting + a rock-solid caret + saving.
 *
 * History: this started as a transparent textarea overlaid on Shiki-highlighted
 * markup, which kept drifting the colored layer from the caret so clicks landed
 * in the wrong place. We fell back to a plain textarea (reliable, no color), and
 * now use CodeMirror — one editor surface, so the caret can't desync, with
 * proper highlighting back. github-dark-flavoured tokens to match the Code tab.
 *
 * Controlled: `value`/`onChange`. No line wrapping — long lines scroll
 * horizontally, the box scrolls vertically. `lang` picks the grammar.
 */

import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit, bracketMatching } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import type { HighlightLang } from '../../lib/highlight';
import { ghDarkExtension, ssEditorTheme } from '../../lib/codemirror';

interface Props {
  value: string;
  onChange: (value: string) => void;
  lang: HighlightLang;
  className?: string;
  placeholder?: string;
}

export function CodeOverlayEditor({ value, onChange, lang, className, placeholder }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the listener pointed at the latest onChange without recreating the view.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount the editor. Recreated only when the grammar changes (stable per usage).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        bracketMatching(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        lang === 'css' ? css() : html(),
        ghDarkExtension,
        ssEditorTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `value`/`placeholder` are seeded once; external updates flow through the
    // sync effect below. Only the grammar warrants a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // External value changes (e.g. Revert resets the text) → replace the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={`ss-codeedit${className ? ` ${className}` : ''}`} />;
}
