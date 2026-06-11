/**
 * Tests for the visual editor's asset picker: images only, picks hand back a
 * root-relative web path, and an upload lands + auto-picks (uploading from the
 * picker means "replace with this file").
 */

import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { ImagePickerModal } from './ImagePickerModal';
import { assetWebPath } from '../../lib/assets';

// The global afterEach (test/setup.ts) clearMocks() wipes the IPC handler after
// every test, and the global one is only registered in a beforeAll — so this file
// registers its own self-contained handler per test, plus the convertFileSrc mock
// the thumbnails render through.
beforeEach(() => {
  mockConvertFileSrc('macos');
  mockIPC((cmd) => {
    if (cmd === 'list_assets') {
      return [
        {
          name: 'hero.png',
          path: 'images/hero.png',
          full_path: '/p/public/images/hero.png',
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
      ];
    }
    if (cmd === 'upload_asset') {
      return {
        name: 'new logo.png',
        path: 'new logo.png',
        full_path: '/p/public/new logo.png',
        size: 3,
        is_directory: false,
        modified_at: 0,
      };
    }
    return undefined;
  });
});

it('lists image assets only — no folders, no non-image files', async () => {
  render(<ImagePickerModal isOpen projectPath="/p" onPick={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText('hero.png')).toBeInTheDocument();
  expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  expect(screen.queryByText('images')).not.toBeInTheDocument();
});

it('hands the picked asset to onPick as a root-relative web path', async () => {
  const onPick = vi.fn();
  render(<ImagePickerModal isOpen projectPath="/p" onPick={onPick} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByTitle('/images/hero.png'));
  expect(onPick).toHaveBeenCalledWith('/images/hero.png');
});

it('highlights the currently-used asset', async () => {
  render(
    <ImagePickerModal
      isOpen
      projectPath="/p"
      currentSrc="/images/hero.png"
      onPick={vi.fn()}
      onClose={vi.fn()}
    />
  );
  expect((await screen.findByTitle('/images/hero.png')).className).toContain('is-current');
});

it('uploads a new image and picks it immediately', async () => {
  const onPick = vi.fn();
  const { container } = render(
    <ImagePickerModal isOpen projectPath="/p" onPick={onPick} onClose={vi.fn()} />
  );
  await screen.findByText('hero.png');
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], 'new logo.png', { type: 'image/png' });
  // jsdom's File has no arrayBuffer() (real WebKit does) — patch the instance.
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
  });
  fireEvent.change(input, { target: { files: [file] } });
  // Spaces in the file name reach the src percent-encoded (one URL, not two tokens).
  await waitFor(() => expect(onPick).toHaveBeenCalledWith('/new%20logo.png'));
});

it('percent-encodes web path segments but keeps the slashes', () => {
  expect(assetWebPath('images/My Logo (1).png')).toBe('/images/My%20Logo%20(1).png');
  expect(assetWebPath('hero.png')).toBe('/hero.png');
});
