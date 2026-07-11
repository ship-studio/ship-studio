import { describe, expect, it } from 'vitest';
import { setAttribute } from './htmlAttrs';

describe('setAttribute', () => {
  it('updates an existing attribute value', () => {
    expect(setAttribute('<a href="/old">x</a>', 'href', '/new')).toBe('<a href="/new">x</a>');
  });

  it('adds a missing attribute before the close', () => {
    expect(setAttribute('<a href="/x">x</a>', 'target', '_blank')).toBe(
      '<a href="/x" target="_blank">x</a>'
    );
    expect(setAttribute('<button>x</button>', 'disabled', '')).toBe(
      '<button disabled="">x</button>'
    );
  });

  it('removes an attribute when value is null', () => {
    expect(setAttribute('<a href="/x" target="_blank">x</a>', 'target', null)).toBe(
      '<a href="/x">x</a>'
    );
  });

  it('preserves a self-closing tag', () => {
    expect(setAttribute('<img src="a.png" />', 'alt', 'hi')).toBe('<img src="a.png" alt="hi" />');
    expect(setAttribute('<input type="text"/>', 'name', 'q')).toBe(
      '<input type="text" name="q" />'
    );
  });

  it('does not match inside the tag name or attribute values', () => {
    // "href" appears in a value but only the real attribute is changed.
    const html = '<a data-x="href" href="/old">x</a>';
    expect(setAttribute(html, 'href', '/new')).toBe('<a data-x="href" href="/new">x</a>');
  });

  it('is quote-aware (a > inside a value does not end the tag)', () => {
    const html = '<a title="a > b" href="/x">x</a>';
    expect(setAttribute(html, 'href', '/y')).toBe('<a title="a > b" href="/y">x</a>');
  });

  it('escapes double quotes in the new value', () => {
    expect(setAttribute('<a>x</a>', 'title', 'say "hi"')).toBe(
      '<a title="say &quot;hi&quot;">x</a>'
    );
  });

  it('returns null for non-element input', () => {
    expect(setAttribute('not html', 'x', 'y')).toBeNull();
  });
});
