import { describe, expect, it } from 'vitest';
import {
  resequence,
  buildMarkdown,
  exportSlug,
  type RedlineAnnotation,
  type RedlineDocument,
  type RedlineLocator,
} from './redline';
import type { ElementSignature } from './edit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SIG: ElementSignature = {
  className: 'text-lg font-bold',
  tagName: 'H1',
  text: 'Welcome',
  ancestorClasses: ['container', 'hero'],
};

const LOCATOR: RedlineLocator = {
  tag: 'h1',
  id: 'hero-title',
  classList: ['text-lg', 'font-bold'],
  role: 'heading',
  ariaLabel: 'Page title',
  textSnippet: 'Welcome',
  dataAttributes: { testid: 'hero' },
  ancestorClasses: ['container', 'hero'],
  nearbyLandmark: 'main',
};

function change(over: Partial<RedlineAnnotation> = {}): RedlineAnnotation {
  return {
    id: 'a1',
    number: 1,
    kind: 'change',
    label: 'Make the heading larger',
    signature: SIG,
    locator: LOCATOR,
    resolvedLocation: null,
    rect: { top: 10, left: 20, width: 100, height: 40 },
    createdAt: CREATED_AT,
    ...over,
  };
}

// No timezone suffix → parsed as LOCAL time, so formatDate's local-field reads
// render `09:30` regardless of the test runner's timezone (the serializer ports
// the original's local-time formatting verbatim).
const CREATED_AT = '2026-06-13T09:30:00';

function doc(
  annotations: RedlineAnnotation[],
  over: Partial<RedlineDocument> = {}
): RedlineDocument {
  return {
    schemaVersion: 1,
    projectPath: '/Users/dev/ShipStudio/site',
    pageUrl: 'https://www.example.com/about/team',
    pageTitle: 'About the Team',
    viewport: { width: 1280, height: 800, dpr: 2 },
    annotations,
    createdAt: CREATED_AT,
    updatedAt: '2026-06-13T09:45:00',
    ...over,
  };
}

// ─── resequence ──────────────────────────────────────────────────────────────

describe('resequence', () => {
  it('renumbers annotations 1..N in array order', () => {
    const d = doc([
      change({ id: 'a', number: 7 }),
      change({ id: 'b', number: 3 }),
      change({ id: 'c', number: 99 }),
    ]);
    const out = resequence(d);
    expect(out.annotations.map((a) => a.number)).toEqual([1, 2, 3]);
    expect(out.annotations.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input document or its annotations', () => {
    const d = doc([change({ id: 'a', number: 5 })]);
    const out = resequence(d);
    expect(d.annotations[0].number).toBe(5);
    expect(out).not.toBe(d);
    expect(out.annotations[0]).not.toBe(d.annotations[0]);
  });

  it('handles an empty document', () => {
    expect(resequence(doc([])).annotations).toEqual([]);
  });
});

// ─── exportSlug ──────────────────────────────────────────────────────────────

describe('exportSlug', () => {
  it('produces YYYY-MM-DD_domain_path_redline', () => {
    const slug = exportSlug('https://www.example.com/about/team', new Date(2026, 5, 13));
    expect(slug).toBe('2026-06-13_example-com_about-team_redline');
  });

  it('strips www and uses "home" for the root path', () => {
    const slug = exportSlug('https://www.acme.io/', new Date(2026, 0, 1));
    expect(slug).toBe('2026-01-01_acme-io_home_redline');
  });

  it('falls back to defaults on a malformed URL', () => {
    const slug = exportSlug('not a url', new Date(2026, 11, 31));
    expect(slug).toBe('2026-12-31_page_home_redline');
  });

  it('is deterministic for a fixed date arg', () => {
    const date = new Date(2026, 5, 13);
    expect(exportSlug('https://example.com/x', date)).toBe(
      exportSlug('https://example.com/x', date)
    );
  });
});

// ─── buildMarkdown ───────────────────────────────────────────────────────────

describe('buildMarkdown', () => {
  it('is byte-for-byte stable for a fixed document', () => {
    const d = doc([change()]);
    expect(buildMarkdown(d, 'shot.png')).toBe(buildMarkdown(d, 'shot.png'));
  });

  it('uses doc.createdAt for the captured timestamp (deterministic, no wall clock)', () => {
    const md = buildMarkdown(doc([change()]), 'shot.png');
    expect(md).toContain('| Captured | 2026-06-13 09:30 |');
  });

  it('renders page/url/viewport/screenshot header cells', () => {
    const md = buildMarkdown(doc([change()]), 'redline.png');
    expect(md).toContain('| Page | About the Team |');
    expect(md).toContain('| URL | https://www.example.com/about/team |');
    expect(md).toContain('| Viewport | 1280x800 @ 2x |');
    expect(md).toContain('| Screenshot | redline.png |');
    expect(md).toContain('| Changes | 1 |');
  });

  it('includes the Source line when resolvedLocation is set, with confidence', () => {
    const md = buildMarkdown(
      doc([
        change({
          resolvedLocation: { file: 'src/components/Hero.tsx', line: 42, column: 8 },
          confidence: 'unique',
        }),
      ]),
      'shot.png'
    );
    expect(md).toContain('- Source: src/components/Hero.tsx:42 (unique)');
  });

  it('omits the Source line when resolvedLocation is null', () => {
    const md = buildMarkdown(doc([change({ resolvedLocation: null })]), 'shot.png');
    expect(md).not.toContain('- Source:');
  });

  it('documents the trust-the-Source-line contract in How to apply', () => {
    const md = buildMarkdown(doc([change()]), 'shot.png');
    expect(md).toContain('A Source line is the exact file:line resolved from the running dev');
    expect(md).toContain('trust it first; the selector/locator are fallbacks.');
  });

  it('emits the verbatim Old/New block for a textedit', () => {
    const md = buildMarkdown(
      doc([
        change({
          kind: 'textedit',
          oldText: 'Sign up free',
          newText: 'Start your trial',
          hasInlineMarkup: false,
        }),
      ]),
      'shot.png'
    );
    expect(md).toContain('### 1. Text edit');
    expect(md).toContain('- Change type: text replacement');
    expect(md).toContain('- Old text: "Sign up free"');
    expect(md).toContain('- New text: "Start your trial"');
  });

  it('warns about inline markup for a textedit when hasInlineMarkup is true', () => {
    const md = buildMarkdown(
      doc([change({ kind: 'textedit', oldText: 'a', newText: 'b', hasInlineMarkup: true })]),
      'shot.png'
    );
    expect(md).toContain('Contains inline markup: yes.');
  });

  it('renders a change request with its label and element locator', () => {
    const md = buildMarkdown(doc([change({ label: 'Tighten spacing' })]), 'shot.png');
    expect(md).toContain('### 1. Tighten spacing');
    expect(md).toContain('- Requested change: Tighten spacing');
    expect(md).toContain('- Element: `<h1 id="hero-title" class="text-lg font-bold">`');
    expect(md).toContain('role: heading');
    expect(md).toContain('aria-label: "Page title"');
    expect(md).toContain('- Current text: "Welcome"');
    expect(md).toContain('- Ancestor classes: container > hero');
    expect(md).toContain('- Data attributes: testid="hero"');
    expect(md).toContain('- Nearby landmark: main');
  });

  it('escapes pipes in table cells', () => {
    const md = buildMarkdown(doc([change()], { pageTitle: 'A | B' }), 'shot.png');
    expect(md).toContain('| Page | A \\| B |');
  });

  it('shows a placeholder when there are no changes', () => {
    const md = buildMarkdown(doc([]), 'shot.png');
    expect(md).toContain('_No labeled changes were captured._');
    expect(md).toContain('*0 change(s) · Ship Studio Redline · schema v1*');
  });
});
