import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { AssetBrowserProvider, useAssetBrowser } from '../../contexts/AssetBrowserContext';
import { ModalProvider } from '../../contexts/ModalContext';
import { PanelDockProvider, usePanelDockBinding } from '../../contexts/PanelDockContext';
import { WorkspaceDock } from './WorkspaceDock';
import { AssetsDockPanel, AssetsPanel } from './AssetsPanel';

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
  return (
    <>
      <button type="button" onClick={() => browser.openManager(true)}>
        Open assets manager
      </button>
      <button type="button" onClick={() => setRenderVersion((version) => version + 1)}>
        Rerender workspace
      </button>
      <AssetsPanel projectPath="/p" />
      <WorkspaceDock preview={<div data-testid="preview" />}>
        <AssetsDockPanel projectPath="/p" dock={dock} docked />
      </WorkspaceDock>
    </>
  );
}

beforeAll(() => vi.stubGlobal('ResizeObserver', ResizeObserverMock));
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
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
