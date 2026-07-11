/**
 * Stress tests for the rule-body parser/serializer against modern CSS: complex
 * values (color-mix, gradients, calc, clamp, data URIs), nesting, container queries,
 * pseudo-elements, and tricky strings. The contract:
 *   1. declarations() / nestedRules() extract the right structure
 *   2. serialize∘parse is a fixed point (canonical form round-trips)
 */
import { describe, expect, it } from 'vitest';
import { parseRuleBody, serializeRuleBody, declarations, nestedRules } from './cssBody';

/** parse → serialize → parse → serialize must be stable (idempotent canonical form). */
function roundTrips(body: string) {
  const once = serializeRuleBody(parseRuleBody(body));
  const twice = serializeRuleBody(parseRuleBody(once));
  expect(twice).toBe(once);
}

describe('modern value parsing', () => {
  const valueCases: Array<[string, string]> = [
    ['color', 'color-mix(in srgb, red 50%, blue)'],
    ['grid-template-columns', 'repeat(3, minmax(0, 1fr))'],
    ['transition', 'color 0.2s ease, background 0.3s ease'],
    ['font-family', '"Helvetica Neue", Arial, sans-serif'],
    ['width', 'clamp(1rem, 2.5vw, 3rem)'],
    ['--ratio', 'calc(16 / 9)'],
    ['box-shadow', '0 1px 2px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.2)'],
    ['background-image', 'linear-gradient(to right, red, blue), url(x.png)'],
    ['aspect-ratio', '16 / 9'],
    ['grid-template', '"a b" 1fr / auto'],
    ['color', 'light-dark(white, black)'],
    ['width', 'min(100%, var(--max, 60ch))'],
    // Wide-gamut + relative color: captured verbatim so an edit to a sibling never
    // rewrites (and corrupts) these values.
    ['color', 'oklch(0.7 0.15 200)'],
    ['background', 'color(display-p3 1 0.5 0)'],
    ['border-color', 'rgb(from var(--brand) r g b / 0.5)'],
    ['color', 'hsl(from var(--c) h s calc(l * 1.2))'],
  ];
  for (const [prop, value] of valueCases) {
    it(`keeps ${prop}: ${value}`, () => {
      const body = parseRuleBody(`\n  ${prop}: ${value};\n`);
      const decls = declarations(body);
      expect(decls).toHaveLength(1);
      expect(decls[0].prop).toBe(prop);
      expect(decls[0].value).toBe(value);
      roundTrips(`\n  ${prop}: ${value};\n`);
    });
  }

  it('protects semicolons inside an unquoted data URI', () => {
    const body = parseRuleBody(
      '\n  background: url(data:image/svg+xml;utf8,<svg/>);\n  color: red;\n'
    );
    const decls = declarations(body);
    expect(decls.map((d) => [d.prop, d.value])).toEqual([
      ['background', 'url(data:image/svg+xml;utf8,<svg/>)'],
      ['color', 'red'],
    ]);
  });

  it('protects semicolons + braces inside a quoted string value', () => {
    const body = parseRuleBody('\n  content: "a; b { c }";\n  color: red;\n');
    const decls = declarations(body);
    expect(decls.map((d) => [d.prop, d.value])).toEqual([
      ['content', '"a; b { c }"'],
      ['color', 'red'],
    ]);
  });

  it('keeps a colon inside an unquoted url() out of the prop/value split', () => {
    const body = parseRuleBody('\n  background: url(http://example.com/a.png) no-repeat;\n');
    const decls = declarations(body);
    expect(decls[0].prop).toBe('background');
    expect(decls[0].value).toBe('url(http://example.com/a.png) no-repeat');
  });
});

describe('modern nesting', () => {
  it('parses a pseudo-element with empty content', () => {
    const body = parseRuleBody('\n  &::after {\n    content: "";\n  }\n');
    const nested = nestedRules(body);
    expect(nested).toHaveLength(1);
    expect(nested[0].selector).toBe('&::after');
    expect(declarations(nested[0].body)).toEqual([
      { index: 0, prop: 'content', value: '""', important: false },
    ]);
  });

  it('parses a nested selector containing commas (&:is(.a, .b))', () => {
    const body = parseRuleBody('\n  &:is(.a, .b) {\n    color: red;\n  }\n');
    const nested = nestedRules(body);
    expect(nested).toHaveLength(1);
    expect(nested[0].selector).toBe('&:is(.a, .b)');
  });

  it('parses a nested @media', () => {
    const body = parseRuleBody(
      '\n  color: red;\n  @media (min-width: 768px) {\n    color: blue;\n  }\n'
    );
    expect(declarations(body).map((d) => d.prop)).toEqual(['color']);
    const nested = nestedRules(body);
    expect(nested[0].selector).toBe('@media (min-width: 768px)');
    expect(declarations(nested[0].body)[0].value).toBe('blue');
  });

  it('parses a nested @container query', () => {
    const body = parseRuleBody('\n  @container (min-width: 400px) {\n    gap: 1rem;\n  }\n');
    expect(nestedRules(body)[0].selector).toBe('@container (min-width: 400px)');
  });

  it('parses deep nesting (& .a { &:hover { … } })', () => {
    const body = parseRuleBody('\n  & .a {\n    &:hover {\n      color: red;\n    }\n  }\n');
    const a = nestedRules(body)[0];
    expect(a.selector).toBe('& .a');
    const hover = nestedRules(a.body)[0];
    expect(hover.selector).toBe('&:hover');
    expect(declarations(hover.body)[0].value).toBe('red');
  });

  it('parses a nested rule whose selector has a string with braces', () => {
    const body = parseRuleBody('\n  &[data-x="{"] {\n    color: red;\n  }\n');
    const nested = nestedRules(body);
    expect(nested).toHaveLength(1);
    expect(nested[0].selector).toBe('&[data-x="{"]');
  });
});

describe('round-trip stability on bigger bodies', () => {
  const bodies = [
    '\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n  gap: clamp(1rem, 2vw, 2rem);\n',
    '\n  color: red;\n  &:hover {\n    color: color-mix(in srgb, red, white 20%);\n  }\n  @media (min-width: 768px) {\n    font-size: 2rem;\n  }\n',
    '\n  background: url(data:image/svg+xml;utf8,<svg/>) center / cover;\n  transition: transform 0.2s, opacity 0.3s;\n',
    '\n  --gap: 8px;\n  padding: var(--gap) calc(var(--gap) * 2);\n',
  ];
  for (const b of bodies) {
    it(`round-trips: ${JSON.stringify(b.slice(0, 40))}…`, () => roundTrips(b));
  }
});
