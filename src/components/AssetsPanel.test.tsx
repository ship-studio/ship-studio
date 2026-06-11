/**
 * Tests for AssetsModal pick mode — the same assets browser the toolbar opens,
 * reused as a file picker (visual editor "Replace image"): only images and
 * folders are listed, files become click-to-pick targets, folders still navigate.
 */

import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { AssetsModal } from './AssetsPanel';

// The global afterEach (test/setup.ts) clearMocks() wipes the IPC handler after
// every test and the global one is only registered in a beforeAll — so this file
// registers its own self-contained handler per test, plus the convertFileSrc
// mock the thumbnails render through.
beforeEach(() => {
  mockConvertFileSrc('macos');
  mockIPC((cmd) => {
    if (cmd === 'get_assets_root') return 'public';
    if (cmd === 'list_assets') {
      return [
        {
          name: 'hero.png',
          path: 'hero.png',
          full_path: '/p/public/hero.png',
          size: 2048,
          is_directory: false,
          modified_at: 0,
        },
        {
          name: 'notes.txt',
          path: 'notes.txt',
          full_path: '/p/public/notes.txt',
          size: 64,
          is_directory: false,
          modified_at: 0,
        },
        {
          name: 'images',
          path: 'images',
          full_path: '/p/public/images',
          size: 0,
          is_directory: true,
          modified_at: 0,
        },
        {
          name: 'logo.svg',
          path: 'images/logo.svg',
          full_path: '/p/public/images/logo.svg',
          size: 128,
          is_directory: false,
          modified_at: 0,
        },
      ];
    }
    return undefined;
  });
});

function renderPicker(onPick = vi.fn(), onClose = vi.fn()) {
  render(
    <AssetsModal
      projectPath="/p"
      isOpen
      onClose={onClose}
      pick={{ title: 'Replace image', onPick }}
    />
  );
  return { onPick, onClose };
}

it('uses the pick title and lists only images and folders', async () => {
  renderPicker();
  expect(screen.getByText('Replace image')).toBeInTheDocument();
  expect(await screen.findByText('hero.png')).toBeInTheDocument();
  expect(screen.getByText('images')).toBeInTheDocument(); // folder kept for navigation
  expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
});

it('clicking an image hands the asset to onPick', async () => {
  const { onPick } = renderPicker();
  fireEvent.click(await screen.findByText('hero.png'));
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0][0]).toMatchObject({ path: 'hero.png', isDirectory: false });
});

it('clicking a folder navigates into it instead of picking', async () => {
  const { onPick } = renderPicker();
  fireEvent.click(await screen.findByText('images'));
  expect(onPick).not.toHaveBeenCalled();
  // Now inside images/ — the nested image shows, the root-level one doesn't.
  expect(await screen.findByText('logo.svg')).toBeInTheDocument();
  expect(screen.queryByText('hero.png')).not.toBeInTheDocument();
});

it('without pick mode, files are not click-to-pick targets', async () => {
  render(<AssetsModal projectPath="/p" isOpen onClose={vi.fn()} />);
  expect(screen.getByText('Assets')).toBeInTheDocument();
  const file = await screen.findByText('notes.txt'); // manager shows ALL files
  const item = file.closest('.assets-item, .assets-grid-item')!;
  expect(item.className).not.toContain('is-pickable');
});
