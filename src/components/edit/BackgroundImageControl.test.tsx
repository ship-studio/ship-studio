import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import {
  AssetBrowserProvider,
  ASSET_BROWSER_PRESENTATION_KEY,
} from '../../contexts/AssetBrowserContext';
import { ModalProvider } from '../../contexts/ModalContext';
import { BASE_BREAKPOINT, type LayerContext, type ResetSpec } from '../../lib/edit';
import { AssetsPanel } from '../workspace/AssetsPanel';
import { BackgroundImageControl } from './BackgroundImageControl';

vi.mock('../../commands/useCommands', () => ({ useCommands: () => undefined }));

const layer: LayerContext = {
  bp: BASE_BREAKPOINT,
  ordered: [BASE_BREAKPOINT],
  known: new Set(),
  utilityPrefix: 'tw-',
};

function PickerHarness({
  selectionKey,
  onApplyEnum,
  computed,
  onReset,
}: {
  selectionKey: string;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  computed?: string;
  onReset?: (spec: ResetSpec) => void;
}) {
  return (
    <ModalProvider>
      <AssetBrowserProvider projectPath="/p" focusMode>
        <BackgroundImageControl
          currentClass="hero"
          layer={layer}
          computed={computed}
          projectPath="/p"
          selectionKey={selectionKey}
          onApplyEnum={onApplyEnum}
          onReset={onReset ?? vi.fn()}
        />
        <AssetsPanel projectPath="/p" />
      </AssetBrowserProvider>
    </ModalProvider>
  );
}

beforeEach(() => {
  localStorage.setItem(ASSET_BROWSER_PRESENTATION_KEY, 'modal');
  mockConvertFileSrc('macos');
  mockIPC((command) => {
    if (command === 'get_assets_root') return 'public';
    if (command === 'list_assets') {
      return [
        {
          name: 'hero.png',
          path: 'hero.png',
          full_path: '/p/public/hero.png',
          size: 2048,
          is_directory: false,
          modified_at: 0,
        },
      ];
    }
    return undefined;
  });
});

it('keeps the real asset picker open and applies the selected background utility', async () => {
  const onApplyEnum = vi.fn();
  render(<PickerHarness selectionKey="first-element" onApplyEnum={onApplyEnum} />);

  const chooseButton = screen.getByRole('button', { name: 'Choose image…' });
  expect(chooseButton).toHaveClass('button--default', 'button--size-default');
  fireEvent.click(chooseButton);

  expect(await screen.findByRole('dialog')).toHaveAccessibleName('Choose background image');
  fireEvent.click(await screen.findByRole('button', { name: 'Choose image hero.png' }));

  await waitFor(() => {
    expect(onApplyEnum).toHaveBeenCalledWith('tw-bg-[url(/hero.png)]', {
      'background-image': 'url(/hero.png)',
    });
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('shows a selected background as a thumbnail field with its filename and independent reset', async () => {
  const onApplyEnum = vi.fn();
  const onReset = vi.fn();
  render(
    <PickerHarness
      selectionKey="first-element"
      computed={'url("/hero\\2e png?version=3")'}
      onApplyEnum={onApplyEnum}
      onReset={onReset}
    />
  );

  const replaceButton = screen.getByRole('button', { name: 'Choose background image: hero.png' });
  expect(screen.getByText('hero.png')).toBeInTheDocument();
  await waitFor(() => {
    const thumbnail = replaceButton.querySelector('img');
    const source = thumbnail?.getAttribute('src');
    expect(source).toBeTruthy();
    expect(decodeURIComponent(source ?? '')).toContain('/p/public/hero.png');
  });

  const resetButton = screen.getByRole('button', { name: 'Reset background image' });
  expect(replaceButton).not.toContainElement(resetButton);
  fireEvent.click(resetButton);
  expect(onReset).toHaveBeenCalledOnce();

  fireEvent.click(replaceButton);
  expect(await screen.findByRole('dialog')).toHaveAccessibleName('Choose background image');
});

it('closes an open picker when the selected element changes', async () => {
  const onApplyEnum = vi.fn();
  const { rerender } = render(
    <PickerHarness selectionKey="first-element" onApplyEnum={onApplyEnum} />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Choose image…' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();

  rerender(<PickerHarness selectionKey="second-element" onApplyEnum={onApplyEnum} />);

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(onApplyEnum).not.toHaveBeenCalled();
});
