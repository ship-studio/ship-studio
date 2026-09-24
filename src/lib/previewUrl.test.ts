import { describe, expect, it } from 'vitest';
import { parsePreviewAddress, splitLocation } from './previewUrl';

describe('splitLocation', () => {
  it('separates the pathname from query and hash', () => {
    expect(splitLocation('/blog?draft=1#top')).toEqual({
      pathname: '/blog',
      suffix: '?draft=1#top',
    });
    expect(splitLocation('/blog#top')).toEqual({ pathname: '/blog', suffix: '#top' });
    expect(splitLocation('/blog')).toEqual({ pathname: '/blog', suffix: '' });
  });

  it('treats a bare query as the root page', () => {
    expect(splitLocation('?a=1')).toEqual({ pathname: '/', suffix: '?a=1' });
    expect(splitLocation('')).toEqual({ pathname: '/', suffix: '' });
  });
});

describe('parsePreviewAddress', () => {
  it('takes a path as typed', () => {
    expect(parsePreviewAddress('/blog/hello?draft=1', '/')).toBe('/blog/hello?draft=1');
    expect(parsePreviewAddress('  /pricing  ', '/')).toBe('/pricing');
  });

  it('applies a bare query or hash to the current page', () => {
    expect(parsePreviewAddress('?utm_source=x', '/pricing')).toBe('/pricing?utm_source=x');
    expect(parsePreviewAddress('#faq', '/pricing')).toBe('/pricing#faq');
  });

  it('accepts a pasted localhost URL', () => {
    expect(parsePreviewAddress('http://localhost:3000/a?b=1#c', '/')).toBe('/a?b=1#c');
    expect(parsePreviewAddress('http://127.0.0.1:5173', '/x')).toBe('/');
  });

  it('refuses other origins rather than loading their path locally', () => {
    expect(parsePreviewAddress('https://example.com/a', '/')).toBeNull();
    expect(parsePreviewAddress('//example.com/a', '/')).toBeNull();
  });

  it('leaves plain text to the page search', () => {
    expect(parsePreviewAddress('blog', '/')).toBeNull();
    expect(parsePreviewAddress('   ', '/')).toBeNull();
  });
});
