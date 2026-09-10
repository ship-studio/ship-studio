import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner, parseReleaseNotes } from './UpdateBanner';
import { checkForUpdate, downloadAndInstall } from '../lib/updater';

vi.mock('../lib/updater', () => ({
  checkForUpdate: vi.fn(),
  downloadAndInstall: vi.fn(),
  restartApp: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn(),
  trackError: vi.fn(),
}));

describe('UpdateBanner', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(downloadAndInstall).mockReset();
  });

  it('parses only the available version into titles and full details', () => {
    const body = `
## What's New in v0.18.0

- **Faster previews** - Preview startup now avoids duplicate work.
- **Sidebar polish** — Project controls stay visible at narrow widths.

## What's New in v0.17.1

- **Older fix** - This should not appear.
`;

    expect(parseReleaseNotes(body, '0.18.0')).toEqual([
      { title: 'Faster previews', detail: 'Preview startup now avoids duplicate work.' },
      { title: 'Sidebar polish', detail: 'Project controls stay visible at narrow widths.' },
    ]);
  });

  it('strips markdown from the published manifest body (bullet-dot notes, no heading)', () => {
    // Verbatim shape of latest.json's `notes`: a leading blank line, "•"
    // bullets, bold titles and backticked paths — no version heading at all.
    const body =
      '\n• **Visual editor breakthroughs** - Elements without a class can finally be inserted\n' +
      '• **Pages Router discovery** - Next.js projects with routes in `pages/` now show their pages\n';

    const notes = parseReleaseNotes(body, '0.18.7');

    expect(notes).toEqual([
      {
        title: 'Visual editor breakthroughs',
        detail: 'Elements without a class can finally be inserted',
      },
      {
        title: 'Pages Router discovery',
        detail: 'Next.js projects with routes in pages/ now show their pages',
      },
    ]);
    const rendered = notes.map((note) => `${note.title} ${note.detail ?? ''}`).join(' ');
    expect(rendered).not.toContain('**');
    expect(rendered).not.toContain('`');
  });

  it('keeps prose release notes instead of dropping them, markdown stripped', () => {
    const body = `## What's New in v0.19.0

**Visual editor breakthroughs** — elements without a class can be inserted.

A second paragraph mentioning \`pages/\` and a [link](https://example.com).`;

    const notes = parseReleaseNotes(body, '0.19.0');

    expect(notes).toEqual([
      {
        title: 'Visual editor breakthroughs',
        detail: 'elements without a class can be inserted.',
      },
      { title: 'A second paragraph mentioning pages/ and a link.', detail: undefined },
    ]);
  });

  it('does not check or render while updater support is disabled', () => {
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(checkForUpdate).not.toHaveBeenCalled();
  });
});
