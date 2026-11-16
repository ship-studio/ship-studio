import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundLayer, BackgroundLayerSettings } from '../../lib/cssBackgroundImage';
import { BackgroundLayerPopover, defaultBackgroundLayer } from './BackgroundLayerPopover';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), flush: vi.fn() },
}));

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('BackgroundLayerPopover placement', () => {
  const settings: BackgroundLayerSettings = {
    size: 'cover',
    position: 'center',
    repeat: 'no-repeat',
    attachment: 'scroll',
  };

  afterEach(() => {
    document
      .querySelectorAll('[data-background-popover-test-style]')
      .forEach((style) => style.remove());
    vi.restoreAllMocks();
  });

  it('keeps viewport coordinates fixed through a late CSS override, rerender, and scroll', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const featureStyles = document.createElement('style');
    featureStyles.dataset.backgroundPopoverTestStyle = 'feature';
    featureStyles.textContent =
      '.ss-background-layer-popover { position: fixed; width: 320px; max-height: 70vh; overflow: auto; }';
    document.head.append(featureStyles);

    const lateOverride = document.createElement('style');
    lateOverride.dataset.backgroundPopoverTestStyle = 'override';
    lateOverride.textContent = '.ss-background-layer-popover { position: relative; }';

    const panel = document.createElement('div');
    panel.className = 'ss-edit-panel';
    const boundary = document.createElement('div');
    boundary.className = 'ss-edit-panel__body';
    const anchor = document.createElement('button');
    boundary.append(anchor);
    panel.append(boundary);
    document.body.append(panel);
    const panelRect = rect(100, 20, 280, 760);
    const boundaryRect = rect(100, 50, 280, 700);
    let anchorRect = rect(200, 700, 160, 24);
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(panelRect);
    vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue(boundaryRect);
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => anchorRect);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (!this.classList.contains('ss-background-layer-popover')) return rect(0, 0, 0, 0);
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      const width = Number.parseFloat(this.style.width) || 320;
      const maxHeight = Number.parseFloat(this.style.maxHeight) || 560;
      return rect(left, top, width, Math.min(560, maxHeight));
    });

    const props = {
      layer: defaultBackgroundLayer('image', 'background-0'),
      anchor,
      settings,
      onChange: vi.fn(),
      onSettingChange: vi.fn(),
      onPickImage: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<BackgroundLayerPopover {...props} />);
    const popover = screen.getByRole('dialog', { name: 'Image settings' });

    document.head.append(lateOverride);
    expect(getComputedStyle(popover).position).toBe('fixed');
    expect(popover.style.position).toBe('fixed');

    const firstPlacement = {
      left: popover.style.left,
      top: popover.style.top,
      width: popover.style.width,
      maxHeight: popover.style.maxHeight,
    };
    const firstRect = popover.getBoundingClientRect();
    expect(firstRect.width).toBe(anchorRect.width);
    expect(firstRect.left).toBeGreaterThanOrEqual(0);
    expect(firstRect.left).toBe(anchorRect.left);
    expect(firstRect.right).toBe(anchorRect.left + anchorRect.width);
    expect(firstRect.top).toBeGreaterThanOrEqual(boundaryRect.top);
    expect(firstRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(firstRect.bottom).toBeLessThanOrEqual(anchorRect.top);

    rerender(<BackgroundLayerPopover {...props} settings={{ ...settings, size: 'contain' }} />);
    expect(popover.style.position).toBe('fixed');
    expect(popover.style.left).toBe(firstPlacement.left);
    expect(popover.style.top).toBe(firstPlacement.top);
    expect(popover.style.maxHeight).toBe(firstPlacement.maxHeight);

    anchorRect = rect(150, 300, 200, 24);
    fireEvent.resize(window);
    const resizedRect = popover.getBoundingClientRect();
    expect(resizedRect.width).toBe(anchorRect.width);
    expect(resizedRect.left).toBe(anchorRect.left);
    expect(resizedRect.right).toBe(anchorRect.left + anchorRect.width);

    anchorRect = rect(-40, 300, 200, 24);
    fireEvent.scroll(window);
    const scrolledRect = popover.getBoundingClientRect();
    expect(getComputedStyle(popover).position).toBe('fixed');
    expect(popover.style.top).not.toBe(firstPlacement.top);
    expect(Number.parseFloat(popover.style.maxHeight)).toBeLessThan(
      Number.parseFloat(firstPlacement.maxHeight)
    );
    expect(scrolledRect.left).toBeGreaterThanOrEqual(0);
    expect(scrolledRect.top).toBeGreaterThanOrEqual(0);
    expect(scrolledRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(scrolledRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(scrolledRect.left).toBe(panelRect.left);
    expect(scrolledRect.width).toBe(anchorRect.width);

    lateOverride.remove();
    panel.remove();
  });

  it('matches the complete background layer row horizontally while using the button vertically', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const panel = document.createElement('div');
    panel.className = 'ss-edit-panel';
    const boundary = document.createElement('div');
    boundary.className = 'ss-edit-panel__body';
    const row = document.createElement('div');
    row.className = 'ss-background-image-control__row';
    const anchor = document.createElement('button');
    row.append(anchor);
    boundary.append(row);
    panel.append(boundary);
    document.body.append(panel);

    const panelRect = rect(100, 20, 400, 760);
    const boundaryRect = rect(100, 50, 400, 700);
    const anchorRect = rect(220, 700, 160, 24);
    let rowRect = rect(160, 660, 260, 40);
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(panelRect);
    vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue(boundaryRect);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(anchorRect);
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rowRect);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (!this.classList.contains('ss-background-layer-popover')) return rect(0, 0, 0, 0);
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      const width = Number.parseFloat(this.style.width) || 320;
      const maxHeight = Number.parseFloat(this.style.maxHeight) || 560;
      return rect(left, top, width, Math.min(560, maxHeight));
    });

    const { unmount } = render(
      <BackgroundLayerPopover
        layer={defaultBackgroundLayer('image', 'background-0')}
        anchor={anchor}
        settings={settings}
        onChange={vi.fn()}
        onSettingChange={vi.fn()}
        onPickImage={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const popover = screen.getByRole('dialog', { name: 'Image settings' });
    let popoverRect = popover.getBoundingClientRect();
    expect(popoverRect.left).toBe(rowRect.left);
    expect(popoverRect.right).toBe(rowRect.right);
    expect(popoverRect.top).toBeLessThan(anchorRect.top);

    rowRect = rect(180, 660, 300, 40);
    fireEvent.resize(window);
    popoverRect = popover.getBoundingClientRect();
    expect(popoverRect.left).toBe(rowRect.left);
    expect(popoverRect.right).toBe(rowRect.right);

    unmount();
    panel.remove();
  });

  it('keeps custom size values editable without repeating the Auto unit label', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const props = {
      layer: defaultBackgroundLayer('image', 'background-0'),
      anchor,
      settings: { ...settings, size: 'auto auto' },
      onChange: vi.fn(),
      onSettingChange: vi.fn(),
      onPickImage: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<BackgroundLayerPopover {...props} />);

    expect(screen.getByRole('textbox', { name: 'Background width' })).toHaveValue('auto');
    expect(screen.getByRole('button', { name: 'Background width format' })).toBeEmptyDOMElement();

    rerender(
      <BackgroundLayerPopover
        {...props}
        settings={{ ...settings, size: 'calc(100% - 20px) auto' }}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Custom size' })).toHaveValue(
      'calc(100% - 20px) auto'
    );
    anchor.remove();
  });

  it('retains authored angle units and directions in the editable angle field', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const onChange = vi.fn<(next: BackgroundLayer) => void>();
    const props = {
      layer: defaultBackgroundLayer('linear', 'background-0'),
      anchor,
      settings,
      onChange,
      onSettingChange: vi.fn(),
      onPickImage: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<BackgroundLayerPopover {...props} />);

    const angle = screen.getByRole('textbox', { name: 'Angle' });
    expect(angle).toHaveValue('90');
    expect(screen.getByRole('button', { name: 'Angle format' })).toHaveTextContent('DEG');
    fireEvent.change(angle, { target: { value: '45turn' } });
    fireEvent.blur(angle);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]?.[0].value).toContain('linear-gradient(45turn');

    rerender(
      <BackgroundLayerPopover
        {...props}
        layer={{ ...props.layer, value: 'linear-gradient(to right, #8b5cf6 0%, #ec4899 100%)' }}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Angle' })).toHaveValue('to right');
    anchor.remove();
  });

  it('aligns stop colour and percentage controls in one shared captioned row', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    render(
      <BackgroundLayerPopover
        layer={defaultBackgroundLayer('linear', 'background-0')}
        anchor={anchor}
        settings={settings}
        onChange={vi.fn()}
        onSettingChange={vi.fn()}
        onPickImage={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const color = screen.getByRole('button', { name: 'Stop 1 color' });
    const position = screen.getByRole('textbox', { name: 'Stop 1 position' });
    expect(screen.getByText('Color stops')).toBeInTheDocument();
    expect(screen.queryByText('Stop 1 color')).not.toBeInTheDocument();
    expect(color.closest('.ss-background-layer-popover__stop')).toBe(
      position.closest('.ss-background-layer-popover__stop')
    );
    expect(color).toHaveClass('ss-background-layer-popover__color-property');
    anchor.remove();
  });

  it.each([
    ['0% 0%', 'Top left'],
    ['50% 50%', 'Center'],
    ['100% 100%', 'Bottom right'],
  ])('shows the selected image-position anchor for %s', (position, name) => {
    render(
      <BackgroundLayerPopover
        layer={defaultBackgroundLayer('image', 'background-0')}
        anchor={null}
        settings={{ ...settings, position }}
        onChange={vi.fn()}
        onSettingChange={vi.fn()}
        onPickImage={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: 'Position preset' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Gradient origin' })).not.toBeInTheDocument();
  });

  it('steps the angle dial in 15 degree increments and toggles repeating gradients', () => {
    const layer = defaultBackgroundLayer('linear', 'background-angle');
    const onChange = vi.fn<(next: BackgroundLayer) => void>();
    render(
      <BackgroundLayerPopover
        layer={layer}
        anchor={null}
        settings={settings}
        onChange={onChange}
        onSettingChange={vi.fn()}
        onPickImage={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Gradient angle' }), {
      key: 'ArrowRight',
    });
    expect(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0].value).toContain(
      'linear-gradient(105deg'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Repeating gradient' }));
    expect(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0].value).toContain(
      'repeating-linear-gradient'
    );
  });

  it('reverses every stop and restores the original values after a second reverse', () => {
    let layer: BackgroundLayer = {
      ...defaultBackgroundLayer('linear', 'background-reverse'),
      value: 'linear-gradient(45deg, red 0%, blue 35%, white 100%)',
    };
    const onChange = vi.fn<(next: BackgroundLayer) => void>((next) => {
      layer = next;
    });
    const props = {
      anchor: null,
      settings,
      onChange,
      onSettingChange: vi.fn(),
      onPickImage: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<BackgroundLayerPopover {...props} layer={layer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reverse gradient stops' }));
    expect(layer.value).toContain('white 0%, blue 65%, red 100%');
    rerender(<BackgroundLayerPopover {...props} layer={layer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reverse gradient stops' }));
    expect(layer.value).toBe('linear-gradient(45deg, red 0%, blue 35%, white 100%)');
    expect(screen.getAllByRole('slider', { name: /Select stop/ })).toHaveLength(3);
  });

  it('accepts typed CSS colors and project variable names for gradient stops', () => {
    const onChange = vi.fn<(next: BackgroundLayer) => void>();
    render(
      <BackgroundLayerPopover
        layer={defaultBackgroundLayer('linear', 'background-color')}
        anchor={null}
        settings={settings}
        variables={[{ name: '--brand-primary', value: '#123456' }]}
        onChange={onChange}
        onSettingChange={vi.fn()}
        onPickImage={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const color = screen.getByRole('combobox', { name: 'Stop 1 color value' });
    fireEvent.change(color, { target: { value: '--brand-primary' } });
    fireEvent.blur(color);
    expect(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0].value).toContain(
      'var(--brand-primary)'
    );
  });

  it('edits radial origin and extent without changing the separate background position', () => {
    const layer = {
      ...defaultBackgroundLayer('radial', 'background-radial'),
      value: 'radial-gradient(ellipse 30px 20px at 50% 50%, red 0%, blue 100%)',
    };
    const onChange = vi.fn<(next: BackgroundLayer) => void>();
    const onSettingChange = vi.fn();
    render(
      <BackgroundLayerPopover
        layer={layer}
        anchor={null}
        settings={{ ...settings, position: 'right bottom' }}
        onChange={onChange}
        onSettingChange={onSettingChange}
        onPickImage={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('group', { name: 'Radial gradient shape' })).toHaveTextContent(
      'Ellipse'
    );
    expect(screen.getByRole('group', { name: 'Radial gradient extent' })).toHaveTextContent(
      'Custom'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Gradient origin top left' }));
    expect(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0].value).toContain(
      'ellipse 30px 20px at left top'
    );
    expect(onSettingChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Position preset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bottom right' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Background tile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Background size preset' })).not.toBeInTheDocument();
  });
});
