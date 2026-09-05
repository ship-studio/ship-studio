import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockInvokeResponse } from '../../test/setup';
import { ColorPicker } from './ColorPicker';

type EyeDropperWindow = Window & {
  EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
};

function renderPicker(value = '#ff0000') {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(<ColorPicker value={value} onChange={onChange} onClose={onClose} />);
  return { onChange, onClose };
}

function renderControlledPicker(value = '#ff0000') {
  const onChange = vi.fn();
  function ControlledPicker() {
    const [current, setCurrent] = useState(value);
    return (
      <ColorPicker
        value={current}
        onChange={(next) => {
          onChange(next);
          setCurrent(next);
        }}
        onClose={() => undefined}
      />
    );
  }
  render(<ControlledPicker />);
  return { onChange };
}

function mockRect(element: Element, width: number, height: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  });
}

afterEach(() => {
  delete (window as EyeDropperWindow).EyeDropper;
  vi.restoreAllMocks();
});

describe('ColorPicker', () => {
  it('closes from the header button', () => {
    const { onClose } = renderPicker();
    expect(screen.getByRole('heading', { name: 'Color picker' }).closest('header')).toHaveAttribute(
      'data-dockable-drag-handle'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close color picker' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes the primary format fields', () => {
    renderPicker('rgba(10, 20, 30, 0.5)');
    expect(screen.getByRole('button', { name: 'HSL' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('H')).toBeInTheDocument();
    expect(screen.getByLabelText('L')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hex' }));
    expect(screen.getByLabelText('Hex')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Alpha' })).toHaveValue('50');

    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    expect(screen.getByLabelText('R')).toHaveValue('10');
    expect(screen.getByLabelText('G')).toHaveValue('20');
    expect(screen.getByLabelText('B')).toHaveValue('30');

    fireEvent.click(screen.getByRole('button', { name: 'HSB' }));
    expect(screen.getByLabelText('S')).toBeInTheDocument();
    expect(screen.getByLabelText('B')).toBeInTheDocument();
  });

  it('emits the CSS syntax selected in the format control', () => {
    const { onChange } = renderPicker('#ff0000');

    fireEvent.click(screen.getByRole('button', { name: 'Hex' }));
    expect(onChange).toHaveBeenLastCalledWith('#ff0000');

    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    expect(onChange).toHaveBeenLastCalledWith('rgb(255, 0, 0)');

    fireEvent.click(screen.getByRole('button', { name: 'HSL' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^hsl\(/));

    fireEvent.click(screen.getByRole('button', { name: 'More color formats' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'OKLCH' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^oklch\(/));

    fireEvent.click(screen.getByRole('button', { name: 'Color format: OKLCH' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'HSB' }));
    expect(onChange).toHaveBeenLastCalledWith('rgb(255, 0, 0)');
  });

  it('opens every format in a body-portalled menu and keeps it clickable', () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'More color formats' }));
    const menu = document.querySelector('.ss-color-picker__format-menu');
    expect(menu).toBeInTheDocument();
    expect(menu?.parentElement).toBe(document.body);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Hex',
      'RGB',
      'HSL',
      'HSB',
      'OKLCH',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'OKLCH' }));
    expect(screen.queryByRole('button', { name: 'HSB' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Color format: OKLCH' })).toHaveTextContent('OKLCH');
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(screen.getByLabelText('C')).toBeInTheDocument();
    expect(screen.getByLabelText('L').closest('label')).toHaveTextContent('%');

    fireEvent.change(screen.getByLabelText('L'), { target: { value: '50' } });
    fireEvent.blur(screen.getByLabelText('L'));
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Color format: OKLCH' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'RGB' }));
    expect(screen.getByRole('button', { name: 'RGB' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clamps valid channel edits and restores invalid input', () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    onChange.mockClear();
    const red = screen.getByLabelText('R');
    fireEvent.change(red, { target: { value: '300' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(red);
    expect(onChange).toHaveBeenLastCalledWith('rgb(255, 0, 0)');

    fireEvent.change(red, { target: { value: 'not a number' } });
    fireEvent.blur(red);
    expect(red).toHaveValue('255');
  });

  it('keeps a controlled hue drag at the selected position', async () => {
    const { onChange } = renderControlledPicker();
    const hue = screen.getByRole('slider', { name: 'Hue' });
    mockRect(hue, 200, 30);
    fireEvent.mouseDown(hue, { clientX: 150, clientY: 15, buttons: 1 });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(Number(hue.getAttribute('aria-valuenow'))).toBeGreaterThan(200);
  });

  it('keeps the picker mounted while moving the saturation puck', async () => {
    const { onChange } = renderControlledPicker();
    const surface = screen.getByRole('slider', { name: 'Color' });
    mockRect(surface, 280, 240);
    fireEvent.mouseDown(surface, { clientX: 210, clientY: 60, buttons: 1 });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(screen.getByRole('dialog', { name: 'Color picker' })).toBeInTheDocument();
    expect(surface).toHaveAttribute('aria-valuetext', expect.stringContaining('Saturation'));
  });

  it('keeps the opening color as a clickable original-value comparison', () => {
    const { onChange } = renderControlledPicker('#ff0000');
    const hue = screen.getByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39, which: 39 });
    expect(onChange).toHaveBeenCalled();

    const restore = screen.getByRole('button', { name: 'Restore original color' });
    expect(restore).toHaveStyle({ backgroundColor: 'rgb(255, 0, 0)' });
    fireEvent.click(restore);
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^hsl\(/));
  });

  it('keeps hue and saturation across HSB field edits that pass through black', () => {
    const { onChange } = renderControlledPicker('#ff0000');
    fireEvent.click(screen.getByRole('button', { name: 'HSB' }));
    expect(screen.getByLabelText('H')).toHaveValue('0');
    expect(screen.getByLabelText('S')).toHaveValue('100');

    // Brightness 0 is black, which has no recoverable hue/saturation in RGB:
    // the fields must keep showing the HSB the user is editing.
    const brightness = screen.getByLabelText('B');
    fireEvent.change(brightness, { target: { value: '0' } });
    fireEvent.blur(brightness);
    expect(onChange).toHaveBeenLastCalledWith('rgb(0, 0, 0)');
    expect(screen.getByLabelText('H')).toHaveValue('0');
    expect(screen.getByLabelText('S')).toHaveValue('100');

    // Typing a hue while black, then raising brightness, gives that hue back.
    const hueField = screen.getByLabelText('H');
    fireEvent.change(hueField, { target: { value: '240' } });
    fireEvent.blur(hueField);
    expect(screen.getByLabelText('H')).toHaveValue('240');

    fireEvent.change(screen.getByLabelText('B'), { target: { value: '100' } });
    fireEvent.blur(screen.getByLabelText('B'));
    expect(onChange).toHaveBeenLastCalledWith('rgb(0, 0, 255)');
  });

  it('preserves alpha when the picker surface changes', () => {
    const { onChange } = renderPicker('rgba(255, 0, 0, 0.5)');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Alpha' }), {
      key: 'ArrowRight',
      keyCode: 39,
      which: 39,
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^hsl/));
  });

  it('copies the selected CSS representation and uses RGB for HSB', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPicker('#ff0000');

    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    fireEvent.click(screen.getByRole('button', { name: /Copy color|Copied color/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('rgb(255, 0, 0)'));
    expect(screen.getByRole('button', { name: 'Copied color' })).toHaveAttribute(
      'data-copied',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Copied color' })).toHaveClass('is-copied');

    fireEvent.click(screen.getByRole('button', { name: 'HSB' }));
    fireEvent.click(screen.getByRole('button', { name: /Copy color|Copied color/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('rgb(255, 0, 0)'));
  });

  it('uses a supported EyeDropper result', async () => {
    const open = vi.fn().mockResolvedValue({ sRGBHex: '#00ff00' });
    (window as EyeDropperWindow).EyeDropper = class {
      open = open;
    };
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Eyedropper' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^hsl\(/)));
  });

  it('uses the native color sampler when the browser EyeDropper is unavailable', async () => {
    mockInvokeResponse('get_color_sampler_support', { available: true, reason: null });
    mockInvokeResponse('sample_screen_color', '#00ff00');
    const { onChange } = renderPicker();
    const button = screen.getByRole('button', { name: 'Eyedropper' });

    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^hsl\(/)));
  });

  it('does not open overlapping native color samplers on rapid clicks', async () => {
    mockInvokeResponse('get_color_sampler_support', { available: true, reason: null });
    let finishSampling: ((color: string) => void) | undefined;
    const sample = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishSampling = resolve;
        })
    );
    mockInvokeResponse('sample_screen_color', sample);
    const { onChange } = renderPicker();
    const button = screen.getByRole('button', { name: 'Eyedropper' });

    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(sample).toHaveBeenCalledOnce();

    finishSampling?.('#00ff00');
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  });

  it('disables the eyedropper with the native support reason when unsupported', async () => {
    const reason = 'The native macOS screen color sampler requires macOS 10.15 or later.';
    mockInvokeResponse('get_color_sampler_support', { available: false, reason });
    renderPicker();
    const button = screen.getByRole('button', { name: 'Eyedropper' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute('title', reason);
  });

  it('has no recent-variable footer', () => {
    renderPicker();
    expect(screen.queryByText('Recent Variables')).not.toBeInTheDocument();
  });
});
