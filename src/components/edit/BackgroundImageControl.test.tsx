import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider } from '../../contexts/ModalContext';
import { AssetBrowserProvider } from '../../contexts/AssetBrowserContext';
import { PanelDockProvider, usePanelDockBinding } from '../../contexts/PanelDockContext';
import {
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
  breakpointPrefixes,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import { ASSET_BROWSER_PRESENTATION_KEY } from '../../contexts/AssetBrowserContext';
import { AssetsDockPanel, AssetsPanel } from '../workspace/AssetsPanel';
import { WorkspaceDock } from '../workspace/WorkspaceDock';
import { BackgroundImageControl, backgroundPreviewValue } from './BackgroundImageControl';
import { cssValueIsValid } from './BackgroundLayerPopover';

vi.mock('../../commands/useCommands', () => ({ useCommands: () => undefined }));
vi.mock('@tauri-apps/api/core', async (importActual) => {
  const actual = await importActual<typeof import('@tauri-apps/api/core')>();
  return { ...actual, convertFileSrc: vi.fn((path: string) => `file-preview:${path}`) };
});

const createApplyEnumSpy = () => vi.fn<(token: string, style: Record<string, string>) => void>();

function expectBackgroundImageCall(
  spy: ReturnType<typeof createApplyEnumSpy>,
  tokenFragment: string,
  valueFragment: string
) {
  expect(
    spy.mock.calls.some(
      ([token, style]) =>
        token.includes(tokenFragment) && (style['background-image'] ?? '').includes(valueFragment)
    )
  ).toBe(true);
}

const layer: LayerContext = {
  bp: BASE_BREAKPOINT,
  ordered: [BASE_BREAKPOINT],
  known: breakpointPrefixes([BASE_BREAKPOINT]),
  utilityPrefix: 'tw-',
};
const mdBreakpoint = DEFAULT_BREAKPOINTS.find((breakpoint) => breakpoint.name === 'md')!;
const mdLayer: LayerContext = {
  bp: mdBreakpoint,
  ordered: [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS],
  known: breakpointPrefixes([BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS]),
  utilityPrefix: 'tw-',
};

function Harness({
  currentClass = 'hero bg-red-500',
  computed,
  computedSettings,
  selectionKey = 'first-element',
  layerContext = layer,
  onApplyEnum = createApplyEnumSpy(),
  onReset = vi.fn(),
}: {
  currentClass?: string;
  computed?: string;
  computedSettings?: Partial<Record<'size' | 'position' | 'repeat' | 'attachment', string>>;
  selectionKey?: string;
  layerContext?: LayerContext;
  onApplyEnum?: (token: string, style: Record<string, string>) => void;
  onReset?: (spec: ResetSpec) => void;
}) {
  return (
    <ModalProvider>
      <AssetBrowserProvider projectPath="/p" focusMode>
        <BackgroundImageControl
          currentClass={currentClass}
          layer={layerContext}
          computed={computed}
          computedSettings={computedSettings}
          projectPath="/p"
          selectionKey={selectionKey}
          onApplyEnum={onApplyEnum}
          onReset={onReset}
        />
        <AssetsPanel projectPath="/p" />
      </AssetBrowserProvider>
    </ModalProvider>
  );
}

function AutosavingHarness() {
  const [currentClass, setCurrentClass] = useState('bg-[image:url(/one.png),_url(/two.png)]');
  const [revision, setRevision] = useState(0);
  const apply = () => {
    setCurrentClass((value) => `${value} autosave-${revision}`);
    setRevision((value) => value + 1);
  };
  return (
    <Harness
      currentClass={currentClass}
      computedSettings={{ size: `${revision + 1}px`, position: 'center', repeat: 'no-repeat' }}
      onApplyEnum={apply}
    />
  );
}

function PinnedAssetsContent({
  onApplyEnum,
}: {
  onApplyEnum: (token: string, style: Record<string, string>) => void;
}) {
  const dock = usePanelDockBinding('assets');
  return (
    <>
      <div className="ss-edit-panel">
        <BackgroundImageControl
          currentClass="hero bg-red-500"
          layer={layer}
          projectPath="/p"
          selectionKey="pinned-picker-element"
          onApplyEnum={onApplyEnum}
          onReset={vi.fn()}
        />
      </div>
      <WorkspaceDock preview={<div data-testid="preview" />}>
        <AssetsDockPanel projectPath="/p" dock={dock} docked />
      </WorkspaceDock>
    </>
  );
}

function PinnedAssetsHarness({
  onApplyEnum,
}: {
  onApplyEnum: (token: string, style: Record<string, string>) => void;
}) {
  return (
    <ModalProvider>
      <PanelDockProvider projectPath="/p">
        <AssetBrowserProvider projectPath="/p">
          <PinnedAssetsContent onApplyEnum={onApplyEnum} />
        </AssetBrowserProvider>
      </PanelDockProvider>
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
          name: 'hero_(wide)_asset.png',
          path: 'hero_(wide)_asset.png',
          full_path: '/p/public/hero_(wide)_asset.png',
          size: 2048,
          is_directory: false,
          modified_at: 0,
        },
      ];
    }
    return undefined;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('adds, edits, reorders with the keyboard, and removes stack layers', async () => {
  const user = userEvent.setup();
  const onApplyEnum = createApplyEnumSpy();
  const onReset = vi.fn();
  render(<Harness onApplyEnum={onApplyEnum} onReset={onReset} />);

  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  const linearRow = screen.getByRole('button', { name: 'Edit Linear gradient layer 1' });
  expect(linearRow).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Linear gradient settings' })).toBeInTheDocument();
  expect(
    document.querySelector('[data-testid="background-layer-panel-scrim"]')
  ).not.toBeInTheDocument();
  const angleInput = screen.getByRole('textbox', { name: 'Angle' });
  fireEvent.change(angleInput, { target: { value: '45deg' } });
  fireEvent.blur(angleInput);
  expectBackgroundImageCall(
    onApplyEnum,
    'bg-[image:linear-gradient(45deg',
    'linear-gradient(45deg'
  );

  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  await user.click(screen.getByRole('button', { name: 'Radial gradient' }));
  const radialRow = screen.getByRole('button', { name: 'Edit Radial gradient layer 1' });
  fireEvent.keyDown(radialRow, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(radialRow);
  expect(screen.getByRole('button', { name: 'Edit Linear gradient layer 1' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit Radial gradient layer 2' })).toBeInTheDocument();
  expectBackgroundImageCall(
    onApplyEnum,
    'bg-[image:linear-gradient(45deg',
    'linear-gradient(45deg'
  );
  const reorderedImage = [...onApplyEnum.mock.calls]
    .reverse()
    .find(([, style]) => style['background-image'] !== undefined)?.[1]['background-image'];
  expect(reorderedImage).toMatch(/^linear-gradient\(45deg/);
  expect(reorderedImage).toContain(', radial-gradient(');
  expect(onReset).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Remove Linear gradient layer' }));
  expect(screen.getByRole('button', { name: 'Edit Radial gradient layer 1' })).toBeInTheDocument();
  expectBackgroundImageCall(onApplyEnum, 'bg-[image:radial-gradient', 'radial-gradient');
});

it('uses one shared add action and keeps the row delete inside the layer surface', () => {
  render(<Harness currentClass="bg-[image:url(/one.png),_url(/two.png)]" />);
  expect(screen.getAllByRole('button', { name: 'Add background layer' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Add image' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Linear gradient' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Radial gradient' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Colour' })).not.toBeInTheDocument();
  const row = screen.getByRole('button', { name: 'Edit one.png layer 1' }).parentElement;
  expect(row).toHaveClass('ss-background-image-control__row');
  expect(
    within(row as HTMLElement).getByRole('button', { name: 'Remove one.png layer' })
  ).toBeInTheDocument();
});

it('keeps an existing layer popover open through the native pointer sequence and autosave rerenders', async () => {
  const user = userEvent.setup();
  render(<AutosavingHarness />);

  const first = screen.getByRole('button', { name: 'Edit one.png layer 1' });
  await user.click(first);
  expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();

  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      })
  );
  const delayedOpeningDown = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(delayedOpeningDown, 'timeStamp', {
    value: performance.timeOrigin + performance.now() - 100,
  });
  act(() => {
    document.body.dispatchEvent(delayedOpeningDown);
  });
  expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();

  await user.click(
    within(screen.getByRole('dialog', { name: 'Image settings' })).getByRole('button', {
      name: 'Cover',
    })
  );
  expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Edit two.png layer 2' }));
  expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit two.png layer 2' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );

  await user.click(screen.getByRole('button', { name: 'Edit two.png layer 2' }));
  expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Edit one.png layer 1' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Edit one.png layer 1' }));
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      })
  );
  await user.click(document.body);
  expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
});

it('keeps known per-layer settings paired when background rows are reordered', () => {
  const onApplyEnum = createApplyEnumSpy();
  render(
    <Harness
      currentClass="bg-[image:url(/one.png),_url(/two.png)] bg-[size:10px,_20px]"
      onApplyEnum={onApplyEnum}
    />
  );
  const first = screen.getByRole('button', { name: 'Edit one.png layer 1' });
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(onApplyEnum).toHaveBeenCalledWith('[background-size:20px,_10px]', {
    'background-size': '20px, 10px',
  });
});

it('accepts only current internal drag data and prevents the valid drop default', async () => {
  const user = userEvent.setup();
  render(<Harness currentClass="bg-[image:url(/one.png),_url(/two.png)]" />);
  const first = screen.getByRole('button', { name: 'Edit one.png layer 1' });
  const second = screen.getByRole('button', { name: 'Edit two.png layer 2' });
  const payload = new Map<string, string>();
  const dataTransfer = {
    setData: (key: string, value: string) => payload.set(key, value),
    getData: (key: string) => payload.get(key) ?? '',
    effectAllowed: 'all',
  };
  fireEvent.drop(second, { dataTransfer });
  expect(screen.getByRole('button', { name: 'Edit one.png layer 1' })).toBeInTheDocument();
  fireEvent.dragStart(first, { dataTransfer });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
  act(() => {
    second.dispatchEvent(drop);
  });
  expect(drop.defaultPrevented).toBe(true);
  expect(screen.getByRole('button', { name: 'Edit two.png layer 1' })).toBeInTheDocument();
  fireEvent.click(first, { detail: 1 });
  expect(screen.queryByRole('dialog', { name: /settings$/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Edit one.png layer 2' }));
  expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();
});

it('opens the shared image browser and persists URLs with parentheses, underscores and queries', async () => {
  const user = userEvent.setup();
  const onApplyEnum = createApplyEnumSpy();
  render(
    <div className="ss-edit-panel">
      <Harness onApplyEnum={onApplyEnum} />
    </div>
  );

  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  await user.click(screen.getByRole('button', { name: 'Image' }));
  expect(
    await screen.findByRole('dialog', { name: 'Choose background image' })
  ).toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Choose image hero_(wide)_asset.png' })
  );

  await waitFor(() => {
    expect(onApplyEnum).toHaveBeenCalledWith('bg-[image:url("/hero_%28wide%29_asset.png")]', {
      'background-image': 'url("/hero_%28wide%29_asset.png")',
    });
  });
  expect(
    await screen.findByRole('button', { name: 'Edit hero_(wide)_asset.png layer 1' })
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Choose image' }));
  expect(
    await screen.findByRole('dialog', { name: 'Choose background image' })
  ).toBeInTheDocument();
  expect(
    document.querySelector('[data-testid="background-layer-panel-scrim"]')
  ).toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Choose image hero_(wide)_asset.png' })
  );
  await waitFor(() => {
    expect(onApplyEnum.mock.calls.length).toBeGreaterThan(5);
  });
});

it('preserves the current layer type until the user picks an image', async () => {
  const user = userEvent.setup();
  const onApplyEnum = createApplyEnumSpy();
  render(<Harness onApplyEnum={onApplyEnum} />);
  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  await user.click(screen.getByRole('button', { name: 'Image' }));

  expect(screen.getByRole('button', { name: 'Edit Linear gradient layer 1' })).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Choose background image' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(screen.getByRole('dialog', { name: 'Linear gradient settings' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Linear gradient' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getByRole('button', { name: 'Edit Linear gradient layer 1' })).toBeInTheDocument();
  expectBackgroundImageCall(onApplyEnum, 'bg-[image:linear-gradient', 'linear-gradient');
  expect(
    onApplyEnum.mock.calls.some(([, style]) => style['background-image']?.includes('url('))
  ).toBe(false);
});

it('switches a gradient to the chosen image exactly once through the shared picker', async () => {
  const user = userEvent.setup();
  const onApplyEnum = createApplyEnumSpy();
  render(<Harness onApplyEnum={onApplyEnum} />);

  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  const writesBeforePick = onApplyEnum.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Image' }));
  const picker = await screen.findByRole('dialog', { name: 'Choose background image' });
  await user.click(
    within(picker).getByRole('button', { name: 'Choose image hero_(wide)_asset.png' })
  );

  await waitFor(() => expect(onApplyEnum.mock.calls).toHaveLength(writesBeforePick + 1));
  expect(onApplyEnum.mock.calls.slice(writesBeforePick)).toEqual([
    [
      'bg-[image:url("/hero_%28wide%29_asset.png")]',
      { 'background-image': 'url("/hero_%28wide%29_asset.png")' },
    ],
  ]);
  expect(onApplyEnum.mock.calls).toHaveLength(writesBeforePick + 1);
  expect(
    screen.getByRole('button', { name: 'Edit hero_(wide)_asset.png layer 1' })
  ).toBeInTheDocument();
});

it('keeps the pinned Assets panel interactive while replacing a gradient with an image', async () => {
  const user = userEvent.setup();
  const onApplyEnum = createApplyEnumSpy();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
  );
  localStorage.setItem(ASSET_BROWSER_PRESENTATION_KEY, 'panel');
  render(<PinnedAssetsHarness onApplyEnum={onApplyEnum} />);

  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  const writesBeforePick = onApplyEnum.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Image' }));

  expect(
    screen.queryByRole('dialog', { name: 'Linear gradient settings' })
  ).not.toBeInTheDocument();
  const dockedAssetsPanel = document.querySelector('.assets-dock-panel');
  expect(dockedAssetsPanel).toHaveTextContent('Choose background image');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(dockedAssetsPanel).toHaveTextContent('Assets'));
  expect(onApplyEnum).toHaveBeenCalledTimes(writesBeforePick);
  expect(screen.getByRole('button', { name: 'Edit Linear gradient layer 1' })).toBeInTheDocument();
  expect(localStorage.getItem(ASSET_BROWSER_PRESENTATION_KEY)).toBe('panel');
});

it('keeps the layer editor open while editing a colour in its portaled picker', async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  render(
    <div className="ss-edit-panel">
      <Harness />
    </div>
  );
  await user.click(screen.getByRole('button', { name: 'Add background layer' }));
  await user.click(screen.getByRole('button', { name: 'Solid color' }));
  const layerDialog = screen.getByRole('dialog', { name: 'Solid colour settings' });
  const panelScrim = document.querySelector('[data-testid="background-layer-panel-scrim"]');
  expect(panelScrim).toBeInTheDocument();
  await user.click(within(layerDialog).getByRole('button', { name: 'Color' }));
  const colorPopover = await waitFor(() => {
    const popover = document.querySelector('.ss-color-picker__floating-surface');
    expect(popover).toBeTruthy();
    return popover as HTMLElement;
  });
  await user.pointer([{ keys: '[MouseLeft>]', target: colorPopover }, { keys: '[/MouseLeft]' }]);
  expect(screen.getByRole('dialog', { name: 'Solid colour settings' })).toBeInTheDocument();
  expect(panelScrim).toBeInTheDocument();
});

it('keeps unsupported computed CSS backgrounds read-only with a reason', () => {
  render(<Harness currentClass="hero" computed="image-set(url(/hero.png) 1x)" />);
  expect(screen.getByText(/cannot safely round-trip/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add background layer' })).toBeDisabled();
});

it('inherits background settings per property through a responsive layer with unrelated declarations', async () => {
  render(
    <Harness
      layerContext={mdLayer}
      currentClass="bg-[image:url(/base.png)] bg-[size:60px] md:p-4"
    />
  );
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit base.png layer 1' }));
    expect(screen.getByRole('textbox', { name: 'Background width' })).toHaveValue('60');
    expect(screen.getByRole('button', { name: 'Background width format' })).toHaveTextContent('PX');
    expect(screen.getByRole('textbox', { name: 'Position' })).toHaveValue('0% 0%');
  });
});

it('reorders authored layers through the Tailwind apply pipeline with paired settings', () => {
  const onApplyEnum = createApplyEnumSpy();
  render(
    <Harness
      layerContext={mdLayer}
      currentClass="bg-[image:url(/one.png),_url(/two.png)] md:p-4"
      computedSettings={{
        size: '100px 50px, cover',
        position: '10% 20%, center',
        repeat: 'repeat-x, no-repeat',
        attachment: 'scroll, fixed',
      }}
      onApplyEnum={onApplyEnum}
    />
  );
  fireEvent.keyDown(screen.getByRole('button', { name: 'Edit one.png layer 1' }), {
    key: 'ArrowDown',
  });
  expect(onApplyEnum).toHaveBeenCalledWith('[background-size:cover,_100px_50px]', {
    'background-size': 'cover, 100px 50px',
  });
  expect(onApplyEnum).toHaveBeenCalledWith('[background-position:center,_10%_20%]', {
    'background-position': 'center, 10% 20%',
  });
  expect(onApplyEnum).toHaveBeenCalledWith('[background-repeat:no-repeat,_repeat-x]', {
    'background-repeat': 'no-repeat, repeat-x',
  });
  expect(onApplyEnum).toHaveBeenCalledWith('[background-attachment:fixed,_scroll]', {
    'background-attachment': 'fixed, scroll',
  });
  expect(onApplyEnum).toHaveBeenCalledWith('bg-[image:url(/two.png),_url(/one.png)]', {
    'background-image': 'url(/two.png), url(/one.png)',
  });
});

it('removes the last image with an explicit none without writing empty setting lists', () => {
  const onApplyEnum = createApplyEnumSpy();
  render(<Harness currentClass="bg-[image:url(/one.png)] bg-cover" onApplyEnum={onApplyEnum} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove one.png layer' }));
  expect(onApplyEnum).toHaveBeenCalledExactlyOnceWith('bg-[image:none]', {
    'background-image': 'none',
  });
});

it('maps known project assets to file sources while preserving direct URLs', () => {
  const sources = { '/hero_%28wide%29_asset.png': 'file-preview:/p/public/hero.png' };
  expect(backgroundPreviewValue('url("/hero_%28wide%29_asset.png")', sources)).toBe(
    'url("file-preview:/p/public/hero.png")'
  );
  expect(backgroundPreviewValue('url(https://example.test/hero.png)', sources)).toBe(
    'url(https://example.test/hero.png)'
  );
});

it('validates CSS values before committing property drafts', () => {
  expect(cssValueIsValid('background-size', 'not a valid size')).toBe(false);
  expect(cssValueIsValid('background-repeat', 'round, no-repeat')).toBe(true);
  expect(cssValueIsValid('background-attachment', 'fixed; color:red')).toBe(false);
});

it('preserves a Tailwind background shorthand that also controls the image', () => {
  render(<Harness currentClass="hero [background:linear-gradient(red,_blue)]" />);
  expect(screen.getByText(/background shorthand also controls the image/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add background layer' })).toBeDisabled();
});

it('cancels the shared asset picker when the selected element changes', async () => {
  const onApplyEnum = createApplyEnumSpy();
  const { rerender } = render(<Harness selectionKey="one" onApplyEnum={onApplyEnum} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add background layer' }));
  const writesBeforePicker = onApplyEnum.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  expect(
    await screen.findByRole('dialog', { name: 'Choose background image' })
  ).toBeInTheDocument();

  rerender(<Harness selectionKey="two" onApplyEnum={onApplyEnum} />);
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Choose background image' })
    ).not.toBeInTheDocument()
  );
  expect(onApplyEnum).toHaveBeenCalledTimes(writesBeforePicker);
});

it('closes the open layer popover when its breakpoint context changes', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Harness currentClass="bg-[image:url(/one.png)]" />);
  await user.click(screen.getByRole('button', { name: 'Edit one.png layer 1' }));
  expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();

  rerender(<Harness currentClass="bg-[image:url(/one.png)]" layerContext={mdLayer} />);
  expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
});

it('cancels a picker when authored layer state changes within the same selection', async () => {
  const onApplyEnum = createApplyEnumSpy();
  const { rerender } = render(
    <Harness currentClass="bg-[image:url(/first.png)]" onApplyEnum={onApplyEnum} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add background layer' }));
  const writesBeforePicker = onApplyEnum.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  expect(
    await screen.findByRole('dialog', { name: 'Choose background image' })
  ).toBeInTheDocument();
  rerender(<Harness currentClass="bg-[image:url(/undo.png)]" onApplyEnum={onApplyEnum} />);
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Choose background image' })
    ).not.toBeInTheDocument()
  );
  expect(onApplyEnum).toHaveBeenCalledTimes(writesBeforePicker);
});
