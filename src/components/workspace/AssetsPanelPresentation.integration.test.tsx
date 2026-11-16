import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { AssetBrowserProvider, useAssetBrowser } from '../../contexts/AssetBrowserContext';
import { ModalProvider } from '../../contexts/ModalContext';
import { PanelDockProvider, usePanelDockBinding } from '../../contexts/PanelDockContext';
import { WorkspaceDock } from './WorkspaceDock';
import { AssetsDockPanel, AssetsPanel } from './AssetsPanel';
import { ModalFrame } from '../primitives/ModalFrame';

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback([], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

function WorkspaceAssets() {
  const browser = useAssetBrowser();
  const dock = usePanelDockBinding('assets');
  const [, setRenderVersion] = useState(0);
  const [nestedOpen, setNestedOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setNestedOpen(true)}>
        Open nested dialog
      </button>
      <button type="button" onClick={() => browser.openManager(true)}>
        Open assets manager
      </button>
      <button
        type="button"
        onClick={() =>
          browser.openPicker({
            projectPath: '/p',
            title: 'Choose background image',
            onPick: pickSpy,
          })
        }
      >
        Pick background image
      </button>
      <button
        type="button"
        onClick={() =>
          browser.openPicker({
            projectPath: '/p',
            title: 'Replace image',
            onPick: pickSpy,
            onPreview: previewSpy,
          })
        }
      >
        Pick replacement image
      </button>
      <button type="button" onClick={() => setRenderVersion((version) => version + 1)}>
        Rerender workspace
      </button>
      <AssetsPanel projectPath="/p" />
      <WorkspaceDock preview={<div data-testid="preview" />}>
        <AssetsDockPanel projectPath="/p" dock={dock} docked />
        <ModalFrame isOpen={nestedOpen} onClose={() => setNestedOpen(false)} title="Nested dialog">
          <p>Nested content</p>
        </ModalFrame>
      </WorkspaceDock>
    </>
  );
}

const pickSpy = vi.fn();
const previewSpy = vi.fn();

beforeAll(() => vi.stubGlobal('ResizeObserver', ResizeObserverMock));
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  pickSpy.mockClear();
  previewSpy.mockClear();
  localStorage.setItem('shipstudio.assets.browserPresentation', 'modal');
  mockConvertFileSrc('macos');
  const originalGetBoundingClientRect = Reflect.get(
    HTMLElement.prototype,
    'getBoundingClientRect'
  ) as (this: HTMLElement) => DOMRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('dockable-panel__placeholder')) {
      return {
        left: 48,
        top: 72,
        right: 408,
        bottom: 692,
        width: 360,
        height: 620,
        x: 48,
        y: 72,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return Reflect.apply(originalGetBoundingClientRect, this, []);
  });
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

it('keeps the docked Assets panel open when Escape exits image replacement mode', async () => {
  const user = userEvent.setup();
  localStorage.setItem('shipstudio.assets.browserPresentation', 'panel');
  render(
    <ModalProvider>
      <PanelDockProvider projectPath="/p">
        <AssetBrowserProvider projectPath="/p">
          <WorkspaceAssets />
        </AssetBrowserProvider>
      </PanelDockProvider>
    </ModalProvider>
  );

  await user.click(screen.getByRole('button', { name: 'Pick replacement image' }));
  const dock = document.querySelector('.dockable-panel__surface[aria-label="Assets panel"]');
  expect(dock).toHaveClass('assets-dock-panel--replacement-picking');
  await user.click(screen.getByRole('button', { name: 'Open nested dialog' }));
  expect(await screen.findByRole('dialog', { name: 'Nested dialog' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nested dialog' })).toBeNull());
  expect(dock).toHaveClass('assets-dock-panel--replacement-picking');
  fireEvent.keyDown(document, { key: 'Escape' });

  await waitFor(() => expect(dock).not.toHaveClass('assets-dock-panel--replacement-picking'));
  expect(dock).toBeInTheDocument();
  expect(dock).toHaveTextContent('Assets');
  expect(pickSpy).not.toHaveBeenCalled();
});

it('previews hovered assets, restores on exit, and commits a selected asset once', async () => {
  const user = userEvent.setup();
  localStorage.setItem('shipstudio.assets.browserPresentation', 'panel');
  render(
    <ModalProvider>
      <PanelDockProvider projectPath="/p">
        <AssetBrowserProvider projectPath="/p">
          <WorkspaceAssets />
        </AssetBrowserProvider>
      </PanelDockProvider>
    </ModalProvider>
  );

  await user.click(screen.getByRole('button', { name: 'Pick replacement image' }));
  const asset = await screen.findByRole('button', { name: 'Choose image hero.png' });
  await user.hover(asset);
  expect(previewSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: 'hero.png' }),
    'public'
  );
  await user.unhover(asset);
  expect(previewSpy).toHaveBeenLastCalledWith(null, 'public');

  await user.hover(asset);
  await user.click(asset);
  await waitFor(() => expect(pickSpy).toHaveBeenCalledTimes(1));
  expect(pickSpy).toHaveBeenCalledWith(expect.objectContaining({ path: 'hero.png' }), 'public');
  expect(
    document.querySelector('.dockable-panel__surface[aria-label="Assets panel"]')
  ).toHaveAttribute('inert');
});

it('keeps Assets controls active after switching the modal into its dock panel', async () => {
  const user = userEvent.setup();
  render(
    <ModalProvider>
      <PanelDockProvider projectPath="/p">
        <AssetBrowserProvider projectPath="/p">
          <WorkspaceAssets />
        </AssetBrowserProvider>
      </PanelDockProvider>
    </ModalProvider>
  );

  await user.click(screen.getByRole('button', { name: 'Open assets manager' }));
  expect(await screen.findByRole('dialog', { name: 'Assets' })).toBeInTheDocument();
  const modalToggle = screen.getByRole('button', { name: 'Toggle Assets panel view' });
  expect(modalToggle).toHaveAttribute('aria-pressed', 'false');
  expect(
    modalToggle.compareDocumentPosition(screen.getByRole('tablist', { name: 'Asset view' })) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();

  const surface = document.body.querySelector<HTMLElement>(
    '.dockable-panel__surface[aria-label="Assets panel"]'
  );
  expect(surface).not.toBeNull();
  expect(surface).toHaveAttribute('inert');

  await user.click(modalToggle);
  await waitFor(() => {
    expect(surface).not.toHaveAttribute('inert');
    expect(surface).not.toHaveAttribute('aria-hidden', 'true');
  });
  const panelToggle = screen.getByRole('button', { name: 'Toggle Assets panel view' });
  expect(panelToggle).toHaveAttribute('aria-pressed', 'true');
  expect(
    panelToggle.compareDocumentPosition(screen.getByRole('tablist', { name: 'Asset view' })) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();

  // A modal or dev refresh can leave a direct DOM inert mutation behind while
  // React's `inert={false}` prop has not changed. The owner repairs it on the
  // next commit and doesn't rely on the prop value changing first.
  surface?.setAttribute('inert', '');
  await user.click(screen.getByRole('button', { name: 'Rerender workspace' }));
  await waitFor(() => expect(surface).not.toHaveAttribute('inert'));

  await user.click(screen.getByRole('button', { name: 'New Folder' }));
  expect(await screen.findByPlaceholderText('Folder name')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'List view' }));
  expect(screen.getByRole('tab', { name: 'List view' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('tab', { name: 'Grid view' }));
  expect(screen.getByRole('tab', { name: 'Grid view' })).toHaveAttribute('aria-selected', 'true');

  const search = screen.getByPlaceholderText('Search assets...');
  await user.type(search, 'missing');
  expect(await screen.findByText('No assets matching "missing"')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Close Assets' }));
  await waitFor(() => expect(surface).toHaveAttribute('inert'));

  await user.click(screen.getByRole('button', { name: 'Open assets manager' }));
  expect(await screen.findByRole('dialog', { name: 'Assets' })).toBeInTheDocument();
  expect(surface).toHaveAttribute('inert');

  await user.click(screen.getByRole('button', { name: 'Toggle Assets panel view' }));
  await waitFor(() => expect(surface).not.toHaveAttribute('inert'));
});

it('preserves an active image pick across modal and panel presentation changes', async () => {
  const user = userEvent.setup();
  pickSpy.mockClear();
  render(
    <ModalProvider>
      <PanelDockProvider projectPath="/p">
        <AssetBrowserProvider projectPath="/p">
          <WorkspaceAssets />
        </AssetBrowserProvider>
      </PanelDockProvider>
    </ModalProvider>
  );

  await user.click(screen.getByRole('button', { name: 'Pick background image' }));
  expect(
    await screen.findByRole('dialog', { name: 'Choose background image' })
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Toggle Assets panel view' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Toggle Assets panel view' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  await user.click(screen.getByRole('button', { name: 'Toggle Assets panel view' }));
  expect(
    await screen.findByRole('dialog', { name: 'Choose background image' })
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Toggle Assets panel view' }));
  await user.click(await screen.findByRole('button', { name: 'Choose image hero.png' }));

  await waitFor(() => expect(pickSpy).toHaveBeenCalledTimes(1));
  expect(pickSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'hero.png' }), 'public');
  expect(
    screen.queryByRole('button', { name: 'Toggle Assets panel view' })
  ).not.toBeInTheDocument();
});

it('cancels an active image pick when the panel is closed', async () => {
  const user = userEvent.setup();
  pickSpy.mockClear();
  render(
    <ModalProvider>
      <PanelDockProvider projectPath="/p">
        <AssetBrowserProvider projectPath="/p">
          <WorkspaceAssets />
        </AssetBrowserProvider>
      </PanelDockProvider>
    </ModalProvider>
  );

  await user.click(screen.getByRole('button', { name: 'Pick background image' }));
  await user.click(screen.getByRole('button', { name: 'Toggle Assets panel view' }));
  await user.click(screen.getByRole('button', { name: 'Close Assets' }));
  await user.click(screen.getByRole('button', { name: 'Open assets manager' }));
  expect(await screen.findAllByText('Assets')).toHaveLength(2);
  expect(pickSpy).not.toHaveBeenCalled();
});
