import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkInlineStyleDelta, scanSource } from './check-inline-styles.mjs';

describe('inline-style governance', () => {
  it('scans static declarations while ignoring computed geometry and platform API values', () => {
    const source =
      "<div style={{ color: 'var(--text-primary)', top: `${top}px`, WebkitAppRegion: 'drag' }} />";
    const entries = scanSource(source, 'src/components/Fixture.tsx');

    assert.deepEqual(
      entries.map(({ property, value }) => ({ property, value })),
      [
        { property: 'color', value: "'var(--text-primary)'" },
        { property: 'WebkitAppRegion', value: "'drag'" },
      ]
    );
    assert.deepEqual(
      checkInlineStyleDelta(entries, {
        entries: [
          { path: 'src/components/Fixture.tsx', property: 'color', value: "'var(--text-primary)'" },
        ],
      }),
      []
    );
  });

  it('reports a new static signature against the checked-in baseline', () => {
    const entries = scanSource(
      `<div style={{ color: 'var(--text-primary)', background: 'var(--surface-panel)' }} />`,
      'src/components/Fixture.tsx'
    );
    const baseline = {
      entries: [
        { path: 'src/components/Fixture.tsx', property: 'color', value: "'var(--text-primary)'" },
      ],
    };

    assert.equal(checkInlineStyleDelta(entries, baseline).length, 1);
    assert.match(checkInlineStyleDelta(entries, baseline)[0], /background/);
  });
});
