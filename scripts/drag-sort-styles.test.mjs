import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/components/drag-sort.css', import.meta.url)),
  'utf8'
);
const tokens = readFileSync(
  fileURLToPath(new URL('../src/styles/global/tokens-components.css', import.meta.url)),
  'utf8'
);
const stylesheetIndex = readFileSync(
  fileURLToPath(new URL('../src/styles/index.css', import.meta.url)),
  'utf8'
);
const workspaceCss = readFileSync(
  fileURLToPath(new URL('../src/styles/features/workspace/dock.css', import.meta.url)),
  'utf8'
);
const sidebarCss = readFileSync(
  fileURLToPath(new URL('../src/styles/features/workspace/sidebar.css', import.meta.url)),
  'utf8'
);
const sidebarProjectDragCss = readFileSync(
  fileURLToPath(new URL('../src/styles/features/workspace/sidebar-project-drag.css', import.meta.url)),
  'utf8'
);

function rule(selector, source = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `expected CSS rule for ${selector}`);
  return match[1];
}

test('ordinary sortable rows have no insertion indicator; tree indicators are explicit opt-in', () => {
  // Rows without a dedicated target use the item's edge, but only when the
  // caller opts in. When a nested target exists, that surface owns the edge.
  assert.match(
    css,
    /\.drag-sort__item\[data-drag-sort-target-indicator='true'\]:not\(\s*:has\(\.drag-sort__target\)\s*\)\.is-target::after/
  );
  assert.match(
    css,
    /\.drag-sort__target\[data-drag-sort-target-indicator='true'\]\.is-target::after/
  );
  assert.doesNotMatch(
    css,
    /\.drag-sort__item\.is-target::after/
  );
});

test('sortable focus indication is keyboard-only', () => {
  assert.doesNotMatch(css, /\.drag-sort__item:focus-within\s*\{/);
  assert.match(css, /\.drag-sort__item:has\(\.drag-sort__handle:focus-visible\)\s*\{/);
});

test('hover-revealed handles keep their hit area and reveal on row interaction', () => {
  const reveal = rule(".drag-sort__handle[data-drag-sort-handle-visibility='hover']");
  assert.match(reveal, /opacity:\s*0/);
  assert.match(reveal, /inline-size:\s*0/);
  assert.match(reveal, /flex-basis:\s*0/);
  assert.match(reveal, /filter:\s*blur\(var\(--space-04\)\)/);
  assert.match(reveal, /transform:\s*scale\(0\.25\)/);
  assert.match(reveal, /transition-property:\s*opacity, transform, filter/);
  assert.match(reveal, /transition-timing-function:\s*var\(--ease-icon-swap\)/);
  assert.match(
    css,
    /\.drag-sort__item:not\(\[data-drag-sort-hover-reveal-blocked='true'\]\):hover[\s\S]*?\.drag-sort__handle\[data-drag-sort-handle-visibility='hover'\]\[data-drag-sort-handle-reveal-on='item'\]/
  );
  assert.match(
    css,
    /\.drag-sort__item:has\(:focus-visible\)[\s\S]*?\.drag-sort__handle\[data-drag-sort-handle-visibility='hover'\]\[data-drag-sort-handle-reveal-on='item'\]/
  );
  assert.match(
    css,
    /\.drag-sort__item:not\(\[data-drag-sort-hover-reveal-blocked='true'\]\):hover[\s\S]*?width:\s*var\(--size-icon-button\)[\s\S]*?transform:\s*scale\(1\)/
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?data-drag-sort-handle-visibility='hover'[\s\S]*?transition:\s*none/
  );
  assert.match(
    sidebarCss,
    /\.sidebar-project-drag-handle\s*\{[^}]*margin-inline-end:\s*calc\(-1 \* var\(--space-06\)\)/s
  );
  assert.match(
    sidebarCss,
    /\.drag-sort__item:not\(\[data-drag-sort-hover-reveal-blocked='true'\]\)[\s\S]*?\.sidebar-project-row:hover[\s\S]*?\.sidebar-project-drag-handle[\s\S]*?margin-inline-end:\s*calc\(-1 \* var\(--space-04\)\)/
  );
});

test('the overlay uses an opaque surface and a semantic elevation token', () => {
  assert.match(tokens, /--drag-sort-overlay-opacity:\s*1\s*;/);
  assert.match(tokens, /--drag-sort-overlay-shadow:\s*var\(--shadow-md\)\s*;/);
  const overlay = rule('.drag-sort__overlay');
  assert.match(overlay, /opacity:\s*var\(--drag-sort-overlay-opacity\)/);
  assert.match(overlay, /box-shadow:\s*var\(--drag-sort-overlay-shadow\)/);
  assert.doesNotMatch(overlay, /border\s*:/);
  assert.match(overlay, /pointer-events:\s*none/);
});

test('reorder transitions are interruptible while overlay settle transitions are phase-specific', () => {
  assert.match(
    rule('.drag-sort__item'),
    /transition:\s*transform var\(--drag-sort-reorder-transition\)/
  );
  assert.doesNotMatch(rule('.drag-sort__overlay'), /transition\s*:/);
  assert.match(
    css,
    /\.drag-sort__overlay\[data-drag-sort-phase='dropping'\],[\s\S]*?transition:\s*transform var\(--drag-sort-settle-transition\)/
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.drag-sort__item,[\s\S]*?\.drag-sort__overlay,[\s\S]*?transition:\s*none/
  );
});

test('the final workspace-row cascade keeps transform after the feature stylesheet loads', () => {
  const primitiveImport = stylesheetIndex.indexOf("@import './components/drag-sort.css'");
  const workspaceImport = stylesheetIndex.indexOf("@import './features/workspace/dock.css'");
  assert.ok(primitiveImport >= 0 && workspaceImport > primitiveImport);

  const sources = [css, workspaceCss];
  let winningTransition = '';
  for (const source of sources) {
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (selector.includes('@media')) continue;
      const appliesToRow = selector.split(',').some((part) => {
        const normalized = part.trim();
        return (
          normalized === '.drag-sort__item' ||
          normalized === '.workspace-layout-menu__row' ||
          normalized === '.drag-sort__item.workspace-layout-menu__row'
        );
      });
      const transition = /transition\s*:\s*([^;]+);/.exec(match[2]);
      if (appliesToRow && transition) winningTransition = transition[1].replace(/\s+/g, ' ');
    }
  }
  assert.match(winningTransition, /background-color/);
  assert.match(winningTransition, /transform var\(--drag-sort-reorder-transition\)/);
  assert.doesNotMatch(winningTransition, /\ball\b/);
});

test('expanded sidebar previews override the full placeholder height with a row token', () => {
  assert.match(
    sidebarCss,
    /\.drag-sort__overlay:has\(\.sidebar-project-row--overlay\)\s*\{[^}]*height:\s*var\(--size-sidebar-project-row\)/s
  );
});

test('workspace project drop slots use the expanded surface and a square top indicator', () => {
  const placeholder = rule(
    '.drag-sort__placeholder.workspace-sidebar-project-drop-placeholder',
    sidebarProjectDragCss
  );
  assert.match(placeholder, /background:\s*var\(--surface-app\)/);
  assert.match(placeholder, /border-radius:\s*0/);
  assert.match(
    placeholder,
    /border-top:\s*var\(--drag-sort-target-indicator-width\) solid var\(--drag-sort-target-indicator\)/
  );
  assert.doesNotMatch(placeholder, /border-bottom\s*:/);
});
