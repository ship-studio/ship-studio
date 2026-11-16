import { expect, it } from 'vitest';
import { utf8ByteOffsetToUtf16Offset, utf8ByteRangeToUtf16Range } from './code';

it('maps UTF-8 source ranges to CodeMirror offsets after multibyte text', () => {
  const source = '/* 🎵 */ src={assets.updates.imgImage}';
  const expression = 'assets.updates.imgImage';
  const startUtf8Byte = new TextEncoder().encode(
    source.slice(0, source.indexOf(expression))
  ).length;
  const endUtf8Byte = startUtf8Byte + new TextEncoder().encode(expression).length;

  expect(utf8ByteOffsetToUtf16Offset(source, startUtf8Byte)).toBe(source.indexOf(expression));
  expect(utf8ByteRangeToUtf16Range(source, { startUtf8Byte, endUtf8Byte })).toEqual({
    start: source.indexOf(expression),
    end: source.indexOf(expression) + expression.length,
  });
});

it('rejects UTF-8 offsets that split a multibyte character', () => {
  expect(utf8ByteOffsetToUtf16Offset('🎵x', 1)).toBeNull();
  expect(utf8ByteRangeToUtf16Range('🎵x', { startUtf8Byte: 0, endUtf8Byte: 1 })).toBeNull();
});
