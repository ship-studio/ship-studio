/**
 * Chrome stacking ladder.
 *
 * The workspace titlebar/header sets `position: relative; z-index:
 * var(--z-workspace-header)`, which makes it a stacking context. Every menu
 * opened from it — the Push dropdown, the Branches menu — is therefore capped
 * at the header's own level no matter how high the menu's `z-index` is. Chrome
 * painted LATER in the document at the SAME level wins the tie and covers
 * those menus outright.
 *
 * That is exactly what happened when the preview toolbar was raised from
 * --z-dropdown to --z-workspace-header (to outrank the pane separators): the
 * toolbar band started painting over the top of the open Push menu, hiding its
 * status line and leaving only the part hanging below the toolbar visible.
 *
 * The ladder pinned here: pane separator < preview toolbar < header chrome.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readCss = (relativePath) => readFileSync(path.join(root, relativePath), 'utf-8');

const tokens = readCss('src/styles/global/tokens-components.css');

/** Numeric value of a z-index token declared in tokens-components.css. */
function tokenValue(name) {
  const match = new RegExp(`${name}\\s*:\\s*(\\d+)\\s*;`).exec(tokens);
  assert.ok(match, `${name} must be defined as a plain number in tokens-components.css`);
  return Number(match[1]);
}

/** The `z-index` declaration of the first rule whose selector matches. */
function zIndexOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(^|[,{}])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(rule, `expected a rule for ${selector}`);
  const declaration = /z-index:\s*([^;]+);/.exec(rule[2]);
  assert.ok(declaration, `expected ${selector} to declare a z-index`);
  return declaration[1].trim();
}

describe('workspace chrome stacking ladder', () => {
  const separator = tokenValue('--z-pane-separator');
  const previewToolbar = tokenValue('--z-preview-toolbar');
  const header = tokenValue('--z-workspace-header');

  it('orders pane separators below the preview toolbar below header chrome', () => {
    assert.ok(
      separator < previewToolbar,
      `--z-pane-separator (${separator}) must sit below --z-preview-toolbar (${previewToolbar})`
    );
    assert.ok(
      previewToolbar < header,
      `--z-preview-toolbar (${previewToolbar}) must sit below --z-workspace-header (${header})`
    );
  });

  it('keeps the preview toolbar off the header tier', () => {
    // Tied with the header, DOM order decides — and the toolbar is painted
    // after the titlebar, so it wins and swallows the header's open menus.
    assert.equal(
      zIndexOf(readCss('src/styles/features/preview-toolbar.css'), '.preview-toolbar'),
      'var(--z-preview-toolbar)'
    );
  });

  it('keeps the preview toolbar above the pane separators it was raised for', () => {
    const consumers = [
      readCss('src/styles/features/preview.css'),
      readCss('src/styles/features/workspace/split-pane.css'),
    ];
    let seen = 0;
    for (const css of consumers) {
      for (const [, token] of css.matchAll(/z-index:\s*var\((--z-pane-separator)\)/g)) {
        seen += 1;
        assert.ok(tokenValue(token) < previewToolbar);
      }
    }
    assert.ok(seen > 0, 'expected the pane separators to still use --z-pane-separator');
  });

  it('keeps the workspace titlebar and header on the header tier', () => {
    const workspaceCss = readCss('src/styles/features/workspace/main.css');
    assert.equal(zIndexOf(workspaceCss, '.workspace-titlebar'), 'var(--z-workspace-header)');
    assert.equal(zIndexOf(workspaceCss, '.workspace-header'), 'var(--z-workspace-header)');
  });

  it('leaves the Push menu at the top of the header stacking context', () => {
    const publishCss = readCss('src/styles/features/publish/dropdown.css');
    assert.equal(zIndexOf(publishCss, '.publish-dropdown-menu'), 'var(--z-modal-overlay)');
    assert.ok(tokenValue('--z-modal-overlay') > header);
  });
});
