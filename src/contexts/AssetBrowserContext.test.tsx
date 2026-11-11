import { act, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AssetBrowserProvider, useAssetBrowser } from './AssetBrowserContext';

type BrowserValue = ReturnType<typeof useAssetBrowser>;

const { modalMock } = vi.hoisted(() => ({
  modalMock: { isOpen: false, open: vi.fn(), close: vi.fn() },
}));

vi.mock('./ModalContext', () => ({ useModal: () => modalMock }));
vi.mock('../commands/useCommands', () => ({ useCommands: () => undefined }));

function Probe({ onValue }: { onValue: (value: BrowserValue) => void }) {
  onValue(useAssetBrowser());
  return null;
}

beforeEach(() => {
  modalMock.isOpen = false;
  modalMock.open.mockClear();
  modalMock.close.mockClear();
  localStorage.setItem('shipstudio.assets.browserPresentation', 'panel');
});

it('opens the modal from the assets command while Focus hides the panel', () => {
  let browser!: BrowserValue;
  render(
    <AssetBrowserProvider projectPath="/project" focusMode>
      <Probe onValue={(value) => (browser = value)} />
    </AssetBrowserProvider>
  );

  act(() => browser.openManager());

  expect(modalMock.open).toHaveBeenCalledTimes(1);
  expect(browser.panelOpen).toBe(false);
});

it('keeps the modal visible when switching to panel presentation during Focus', () => {
  let browser!: BrowserValue;
  render(
    <AssetBrowserProvider projectPath="/project" focusMode>
      <Probe onValue={(value) => (browser = value)} />
    </AssetBrowserProvider>
  );

  act(() => browser.switchPresentation('panel'));

  expect(modalMock.open).toHaveBeenCalledTimes(1);
  expect(browser.presentation).toBe('panel');
  expect(browser.panelOpen).toBe(false);
});

it('toggles the manager panel open and closed', () => {
  let browser!: BrowserValue;
  render(
    <AssetBrowserProvider projectPath="/project">
      <Probe onValue={(value) => (browser = value)} />
    </AssetBrowserProvider>
  );

  act(() => browser.toggleManager());
  expect(browser.panelOpen).toBe(true);

  act(() => browser.toggleManager());
  expect(browser.panelOpen).toBe(false);
});

it('closes an open modal when the manager toggle is activated', () => {
  let browser!: BrowserValue;
  modalMock.isOpen = true;
  render(
    <AssetBrowserProvider projectPath="/project">
      <Probe onValue={(value) => (browser = value)} />
    </AssetBrowserProvider>
  );

  act(() => browser.toggleManager());

  expect(modalMock.close).toHaveBeenCalledTimes(1);
  expect(browser.panelOpen).toBe(false);
});
