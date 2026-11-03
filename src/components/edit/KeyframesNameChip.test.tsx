import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyframesNameChip, keyframesName } from './KeyframesNameChip';

// Read from disk: Vitest's default CSS handling empties a `?raw` CSS import,
// and this project's tsconfig has no Node types, hence the narrow cast.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const cssOf = (file: string) => readFileSync(`src/styles/features/css-cascade/${file}`, 'utf8');
const cardsCss = cssOf('cards.css');
const chipsCss = cssOf('chips.css');

describe('keyframesName', () => {
  it('strips the at-keyword, vendor prefix included', () => {
    expect(keyframesName('@keyframes fadeIn')).toBe('fadeIn');
    expect(keyframesName('@-webkit-keyframes  spin ')).toBe('spin');
  });
});

describe('KeyframesNameChip layout', () => {
  let style: HTMLStyleElement | null = null;
  afterEach(() => {
    style?.remove();
    style = null;
  });

  function renderInSelectorField(name: string) {
    // Same order as src/styles/index.css: cards.css, then chips.css.
    style = document.createElement('style');
    style.textContent = `${cardsCss}\n${chipsCss}`;
    document.head.appendChild(style);
    render(
      <div className="ss-cascade-card__selector-field">
        <KeyframesNameChip name={name} onCommit={vi.fn()} />
      </div>
    );
    return screen.getByRole('button');
  }

  function matchingRules(element: Element): CSSStyleRule[] {
    return Array.from(style?.sheet?.cssRules ?? [])
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter((rule) => element.matches(rule.selectorText));
  }

  it('is not capped by the media tone 45% that clipped it to "@keyfra"', () => {
    // 45% resolves against the shrink-to-fit selector field — the chip's own
    // label — so any percentage cap below 100% cuts the `@keyframes` keyword.
    // chips.css loads after cards.css, so at equal specificity its media-tone
    // `max-width: 45%` wins. jsdom drops the `min(var(...), 100%)` that should
    // replace it, so compare the two rules' specificity rather than the
    // computed value (the real rendering is checked in a browser).
    const chip = renderInSelectorField('fadeIn');
    const specificity = (selector: string) => (selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;
    const rules = matchingRules(chip).filter((rule) => rule.cssText.includes('max-width'));
    const ownRule = rules.find((rule) => rule.selectorText.includes('ss-keyframes-name-chip'));
    const toneRule = rules.find((rule) =>
      /^\.ss-cascade-chip\[data-tone=['"]media['"]\]$/.test(rule.selectorText)
    );
    expect(toneRule?.style.getPropertyValue('max-width')).toBe('45%');
    expect(ownRule).toBeDefined();
    expect(specificity(ownRule!.selectorText)).toBeGreaterThan(specificity(toneRule!.selectorText));
  });

  it('never shrinks the @keyframes keyword; only the name ellipsizes', () => {
    renderInSelectorField('a-really-long-animation-name');
    const keyword = screen.getByText('@keyframes');
    // jsdom does not compute flex-shrink, so read it from the matching rules.
    const shrinks = matchingRules(keyword)
      .map((rule) => rule.style.getPropertyValue('flex-shrink'))
      .filter(Boolean);
    expect(shrinks).toContain('0');
    const name = screen.getByText('a-really-long-animation-name');
    expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
  });
});
