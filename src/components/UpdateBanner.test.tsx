import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
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

  it('never renders raw bold markers in the modal', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      update: {} as Update,
      info: {
        version: '0.18.7',
        date: undefined,
        body: '\n• **Visual editor breakthroughs** - Elements without a class can be inserted\n',
      },
    });

    const user = userEvent.setup();
    render(<UpdateBanner />);

    await user.click(
      await screen.findByRole('button', { name: "View what's new in version 0.18.7" })
    );

    const dialog = screen.getByRole('dialog', { name: "What's New in v0.18.7" });
    expect(
      within(dialog).getByRole('heading', { name: 'Visual editor breakthroughs' })
    ).toBeVisible();
    expect(dialog.textContent).not.toContain('**');
  });

  it('opens the release-specific modal from the sidebar indicator', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      update: {} as Update,
      info: {
        version: '0.18.0',
        date: '2026-08-05',
        body: `## What's New in v0.18.0\n\n- **Faster previews** - Preview startup now avoids duplicate work.`,
      },
    });

    const user = userEvent.setup();
    render(<UpdateBanner />);

    await screen.findByRole('button', { name: 'Update Ship Studio to version 0.18.0' });
    await user.click(screen.getByRole('button', { name: "View what's new in version 0.18.0" }));

    expect(downloadAndInstall).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: "What's New in v0.18.0" });
    expect(within(dialog).getByRole('heading', { name: 'Faster previews' })).toBeVisible();
    expect(within(dialog).getByText('Preview startup now avoids duplicate work.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Later' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Update Now' })).toBeVisible();
  });

  it('keeps download progress and the restart action in the banner', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      update: {} as Update,
      info: {
        version: '0.18.0',
        date: '2026-08-05',
        body: '- **Faster previews** - Preview startup now avoids duplicate work.',
      },
    });

    let finishDownload: (() => void) | undefined;
    vi.mocked(downloadAndInstall).mockImplementation((_update, onProgress) => {
      onProgress?.(37);
      return new Promise<void>((resolve) => {
        finishDownload = resolve;
      });
    });

    const user = userEvent.setup();
    const { container } = render(<UpdateBanner />);

    await user.click(
      await screen.findByRole('button', { name: 'Update Ship Studio to version 0.18.0' })
    );

    expect(await screen.findByText('Downloading…')).toBeVisible();
    expect(screen.getByLabelText('37% downloaded')).toHaveTextContent('37%');
    expect(container.querySelector('.update-indicator-progress-fill')).toHaveStyle({
      width: '37%',
    });

    act(() => {
      finishDownload?.();
    });

    expect(await screen.findByText('Click to restart')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restart to apply version 0.18.0' })).toBeEnabled();
  });
});
