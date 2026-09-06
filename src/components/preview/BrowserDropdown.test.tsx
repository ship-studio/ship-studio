import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserDropdown } from './BrowserDropdown';
import { checkBrowserAvailability, openUrlInBrowser, type BrowserInfo } from '../../lib/browser';

vi.mock('../../lib/browser', () => ({
  checkBrowserAvailability: vi.fn(),
  openUrlInBrowser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedAvailability = vi.mocked(checkBrowserAvailability);
const mockedOpen = vi.mocked(openUrlInBrowser);

// Shape the backend returns after discovery: a real icon per browser on macOS,
// opaque bundle identifiers as ids.
const DISCOVERED: BrowserInfo[] = [
  { id: 'com.google.Chrome', name: 'Google Chrome', icon: 'data:image/png;base64,QUFB' },
  { id: 'net.imput.helium', name: 'Helium', icon: 'data:image/png;base64,QkJC' },
  { id: 'com.apple.Safari', name: 'Safari', icon: 'data:image/png;base64,Q0ND' },
  { id: 'app.zen-browser.zen', name: 'Zen', icon: 'data:image/png;base64,RERE' },
];

const openDropdown = async (browsers: BrowserInfo[]) => {
  mockedAvailability.mockResolvedValue(browsers);
  const { container } = render(<BrowserDropdown url="http://localhost:3000" />);
  // The trigger only grows a dropdown once discovery has returned something.
  await waitFor(() => expect(screen.getByText('Open')).toBeInTheDocument());
  fireEvent.mouseEnter(container.querySelector('.browser-dropdown-container')!);
  return container;
};

describe('BrowserDropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists every discovered browser, not just the well-known ones', async () => {
    await openDropdown(DISCOVERED);

    for (const { name } of DISCOVERED) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
  });

  it("shows each browser's own icon when the backend extracted one", async () => {
    const container = await openDropdown(DISCOVERED);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Zen' })).toBeInTheDocument());
    const icons = container.querySelectorAll('.browser-dropdown-inner img.browser-dropdown-icon');
    expect(icons).toHaveLength(DISCOVERED.length);
    expect(icons[1]).toHaveAttribute('src', 'data:image/png;base64,QkJC');
    // Decorative — the name label right beside it already announces the browser.
    expect(icons[1]).toHaveAttribute('alt', '');
  });

  it('falls back to a drawn mark when no icon could be extracted (Windows)', async () => {
    const container = await openDropdown([
      { id: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', name: 'Firefox', icon: null },
    ]);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Firefox' })).toBeInTheDocument()
    );
    expect(container.querySelector('.browser-dropdown-icon')).toBeNull();
    expect(container.querySelector('.browser-dropdown-inner svg')).toBeInTheDocument();
  });

  it('opens the clicked browser by its opaque id', async () => {
    await openDropdown(DISCOVERED);

    fireEvent.click(await screen.findByRole('button', { name: 'Helium' }));

    await waitFor(() =>
      expect(mockedOpen).toHaveBeenCalledWith('http://localhost:3000', 'net.imput.helium')
    );
  });

  it('degrades to a plain button when nothing could be discovered', async () => {
    mockedAvailability.mockResolvedValue([]);
    const { container } = render(<BrowserDropdown url="http://localhost:3000" />);

    await waitFor(() => expect(screen.getByText('Open')).toBeInTheDocument());
    expect(container.querySelector('.browser-dropdown-container')).toBeNull();
  });
});
