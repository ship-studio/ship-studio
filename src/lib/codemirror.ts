/**
 * Shared CodeMirror 6 building blocks for the app's inline editors:
 * the visual editor's HTML/CSS box (`CodeOverlayEditor`) and the Code tab's
 * file editor (`CodeFileEditor`).
 *
 * Keeps one github-dark token palette and one chrome theme shared by both
 * editors — don't fork these per editor.
 *
 * @module lib/codemirror
 */

import type { Extension } from '@codemirror/state';
import { Prec, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

/* Shared syntax palette, with semantic colors matching the visual editor. */
export const ghDarkHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#ff7b72' },
  { tag: [t.propertyName], color: 'var(--property-text)' },
  { tag: [t.variableName], color: 'var(--variable-text)' },
  { tag: [t.function(t.variableName), t.labelName], color: '#d2a8ff' },
  {
    tag: [t.number, t.bool, t.atom, t.color, t.constant(t.name), t.standard(t.name)],
    color: 'var(--property-text)',
  },
  {
    tag: [t.typeName, t.namespace, t.changed, t.annotation, t.self],
    color: 'var(--property-text)',
  },
  { tag: [t.className], color: 'var(--class-text)' },
  // Quoted attribute values (Tailwind class lists) render as Class-orange;
  // unquoted element text inherits the editor's base --text-inverse.
  { tag: [t.string, t.special(t.string)], color: 'var(--class-text)' },
  { tag: [t.comment, t.meta], color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.tagName], color: 'var(--tag-text)' },
  { tag: [t.attributeName], color: 'var(--property-text)' },
  { tag: [t.invalid], color: '#f85149' },
]);

/* Editor chrome, themed with our tokens so it matches the panel surface. */
export const ssEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text-primary)',
      backgroundColor: 'var(--surface-control)',
      fontSize: 'var(--font-size-badge)',
    },
    '&.cm-focused': { outline: 'none' },
    // CSS `--custom-property` names (see cssVarHighlight) in Variable-purple.
    '.cm-css-var': { color: 'var(--variable-text)' },
    '.cm-scroller': {
      fontFamily: 'var(--font-code)',
      lineHeight: '1.6',
      overflow: 'auto',
      // Custom, theme-matched scrollbars (never the device's white default).
      scrollbarWidth: 'thin',
      scrollbarColor: 'var(--border-default) transparent',
      // Promote to its own compositing layer so the native caret has a clean
      // backing store and paints inside the panel's fixed, rounded, clipped box
      // (without this, WebKit drops the caret entirely — see .cm-content).
      transform: 'translateZ(0)',
    },
    '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
    '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'var(--border-default)',
      borderRadius: '999px',
      border: '2px solid var(--surface-control)',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': { background: 'var(--text-muted)' },
    '.cm-scroller::-webkit-scrollbar-corner': { background: 'transparent' },
    // Native caret, tinted bright. It renders invisibly inside the panel's
    // rounded `overflow:hidden` compositing layer (a known WebKit bug) unless the
    // editor is promoted to its own backing layer — see `.cm-scroller` above.
    '.cm-content': {
      padding: 'var(--spacing-sm) 0',
      caretColor: 'var(--text-inverse, #fff)',
    },
    '.cm-line': { padding: '0 var(--spacing-sm)' },
    '.cm-cursor, .cm-cursor-primary': {
      borderLeftColor: 'var(--text-inverse, #fff)',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--tint)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--tint-strong)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-control)',
      color: 'var(--text-muted)',
      border: 'none',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  },
  { dark: true }
);

/**
 * Purple-mark `--custom-property` names wherever they appear (e.g. the
 * `var(--foreground)` fragments inside Tailwind arbitrary-value class strings,
 * which CodeMirror only sees as one orange string token). Scans visible ranges
 * for `--name` and wraps matches in a mark styled by ssEditorTheme.
 */
const cssVarMark = Decoration.mark({ class: 'cm-css-var' });

function buildCssVarDecorations(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const re = /--[a-zA-Z][a-zA-Z0-9-]*/g;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      marks.push(cssVarMark.range(from + match.index, from + match.index + match[0].length));
    }
  }
  return Decoration.set(marks, true);
}

export const cssVarHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCssVarDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildCssVarDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

export const ghDarkExtension: Extension = [syntaxHighlighting(ghDarkHighlight), cssVarHighlight];

/**
 * Render syntax-error tokens as ordinary text instead of red. The Code tab is a
 * viewer first; flagging every malformed/in-progress file with red error tokens
 * is noisy, so we suppress it. Layered at high precedence so it overrides
 * ghDarkHighlight's `t.invalid` rule for the Code tab only.
 */
export const neutralizeInvalidHighlight: Extension = Prec.high(
  syntaxHighlighting(HighlightStyle.define([{ tag: t.invalid, color: 'var(--text-primary)' }]))
);

/**
 * Metrics for the Code tab's full-file editor (used in both read and edit mode):
 * a comfortable 16px, a transparent surface, and the JetBrains Mono stack.
 * Without this the editor would render in the denser `--font-size-badge` / 1.6
 * line-height of `ssEditorTheme`. Layered AFTER `ssEditorTheme`; deliberately
 * NOT applied to the visual editor's overlay editor, which keeps the compact
 * metrics.
 */
export const codeTabEditorTheme = EditorView.theme({
  // Larger, readable code text on a transparent surface so the code area shows
  // the panel background. Element text content (headings, paragraphs) has no
  // syntax token, so this base color IS its color — white, per --text-inverse.
  '&': {
    fontSize: 'var(--font-size-h4)',
    backgroundColor: 'transparent',
    color: 'var(--text-inverse)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '24px',
  },
  '.cm-content': { paddingTop: '12px' },
  // Clearly visible, contiguous selection (drawSelection paints full-line-height
  // rects). Brighter than the shared theme's faint white tint, and it stays
  // visible when the editor isn't focused (read-only select-to-agent mode).
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(var(--info-rgb), 0.35)',
  },
  // Match the viewer's code column: 12px left pad so text starts at the same x.
  '.cm-line': { paddingLeft: '12px' },
  // Mirror the viewer's gutter exactly: a bg-secondary column with a right
  // divider, numbers right-aligned 12px from the divider in text-muted — so the
  // code doesn't shift horizontally when toggling Edit on/off.
  '.cm-gutters': {
    backgroundColor: 'var(--surface-panel)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--border-default)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '52px',
    padding: '0 12px 0 0',
    boxSizing: 'border-box',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
});

/**
 * Surface-only override for the Code tab editor: repaint the editor body and
 * gutter with `--surface-app` so they match the Agent panel instead of
 * `ssEditorTheme`'s `--surface-control`. High precedence so it wins the
 * cascade over `ssEditorTheme` regardless of style-mount order — and nothing
 * else (fonts, sizes, spacing) is touched.
 */
export const codeTabSurfaceTheme = Prec.high(
  EditorView.theme({
    '&': { backgroundColor: 'var(--surface-app)' },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-app)',
    },
    // Once the code is scrolled sideways, separate the sticky gutter column
    // from the code passing beneath it. The class is toggled by the editor's
    // scroll handler (CodeFileEditor); at scrollLeft 0 there is no border.
    '&.ss-code-hscrolled .cm-gutters': {
      borderRight: '1px solid var(--border-default)',
    },
  })
);

/**
 * Map a Shiki language id (as returned by `read_project_file`) to a CodeMirror
 * grammar extension. Returns `[]` for languages without a bundled grammar — the
 * file is still fully editable, just without syntax colors. We only bundle the
 * grammars common in the supported starters to keep the dependency surface small.
 */
export function codeLanguageExtension(language: string): Extension {
  switch (language) {
    case 'javascript':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
      return json();
    case 'html':
    case 'astro':
    case 'vue':
    case 'svelte':
      // Close-enough HTML highlighting for the templating languages.
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'markdown':
      return markdown();
    default:
      return [];
  }
}
