import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockInvokeResponse } from '../../test/setup';
import { ColorPicker } from './ColorPicker';
import { colorPickerFloatingHeight } from '../../lib/color';

type EyeDropperWindow = Window & {
  EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
};

const recentFallbackProjectPath = '/test/color-picker-recent-fallback';
const recentFallbackStorageKey = `shipstudio.color-picker.recent.v1:${encodeURIComponent(recentFallbackProjectPath)}`;
const contrastCheckerStorageKey = 'shipstudio.color-picker.contrast-checker';

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
  window.localStorage.removeItem(recentFallbackStorageKey);
  window.localStorage.removeItem(contrastCheckerStorageKey);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ColorPicker', () => {
  it('keeps the base height when a constrained measurement collapses', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    expect(colorPickerFloatingHeight(4)).toBe(510);
  });

  it('clamps intrinsic content height to a short viewport', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(420);
    expect(colorPickerFloatingHeight(628)).toBe(404);
  });

  it('closes from the header button', () => {
    const { onClose } = renderPicker();
    expect(screen.getByRole('heading', { name: 'Color picker' }).closest('header')).toHaveAttribute(
      'data-dockable-drag-handle'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close color picker' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // #1211 / #1212: the Variables tab runs every custom property on the page
  // through the color parser to find the colors. culori throws (rather than
  // returning undefined) on a function carrying a length, so one
  // `--lift: translateY(-4px)` crashed the whole app when a swatch was opened.
  it('lists color variables when the project also defines non-color function values', () => {
    render(
      <ColorPicker
        value="#336699"
        variables={[
          { name: '--brand', value: '#336699' },
          { name: '--lift', value: 'translateY(-4px)' },
          { name: '--soft', value: 'blur(4px)' },
          { name: '--bad-rgb', value: 'rgb(10px 0 0)' },
        ]}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    expect(screen.getByRole('option', { name: /--brand/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /--lift/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /--soft/ })).not.toBeInTheDocument();
  });

  it('searches project color variables and commits their authored var() value', () => {
    const onChange = vi.fn();
    render(
      <ColorPicker
        value="var(--unknown-color)"
        authoredValue="var(--unknown-color)"
        variables={[{ name: '--brand', value: '#336699' }, { name: '--unknown-color' }]}
        onChange={onChange}
        onClose={() => undefined}
      />
    );

    const variablesTab = screen.getByRole('tab', { name: 'Variables' });
    fireEvent.click(variablesTab);
    expect(variablesTab).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('option', { name: '--unknown-color, preview unavailable' })
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search color variables' }), {
      target: { value: 'brand' },
    });
    fireEvent.click(screen.getByRole('option', { name: '--brand' }));

    expect(onChange).toHaveBeenLastCalledWith('var(--brand)');
  });

  it('checks a known color pair and only enables AAA for text', () => {
    render(
      <ColorPicker
        value="#ffffff"
        contrastContext={{ backgroundColor: '#000000', category: 'normal-text' }}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Pass AA, 4.5:1 required');
    expect(screen.getByRole('button', { name: /Contrast color pair, 21\.00 : 1/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Contrast settings' }));
    expect(screen.getByRole('menuitem', { name: 'AAA · Only for text' })).toBeEnabled();
  });

  it('keeps the AAA preference when switching temporarily to graphics', () => {
    render(
      <ColorPicker
        value="#ffffff"
        contrastContext={{ backgroundColor: '#000000', category: 'normal-text' }}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Contrast settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'AAA · Only for text' }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Pass AAA, 7:1 required');

    fireEvent.click(screen.getByRole('button', { name: 'Contrast settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Graphics' }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Pass AA, 3:1 required');

    fireEvent.click(screen.getByRole('button', { name: 'Contrast settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Normal text' }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Pass AAA, 7:1 required');
  });

  it('does not infer a foreground color when an authored variable is unresolved', () => {
    render(
      <ColorPicker
        value="var(--missing-color)"
        authoredValue="var(--missing-color)"
        variables={[{ name: '--missing-color' }]}
        contrastContext={{ backgroundColor: '#ffffff', category: 'normal-text' }}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));
    expect(screen.getByRole('status', { name: /Contrast check unavailable/ })).toHaveAttribute(
      'aria-label',
      'Contrast check unavailable. Foreground color is unavailable.'
    );
    expect(
      screen.getByRole('button', {
        name: /Contrast color pair ratio unavailable: Foreground color is unavailable/,
      })
    ).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /Restore original color/ })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    expect(screen.getByRole('slider', { name: 'Color' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /Contrast check unavailable/ })).toBeInTheDocument();
  });

  it('calculates contrast with fractional rendered background channels intact', () => {
    render(
      <ColorPicker
        value="#000000"
        contrastContext={{
          backgroundColor: 'rgb(127.5 127.5 127.5)',
          category: 'normal-text',
        }}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));
    expect(
      screen.getByRole('button', { name: /Contrast color pair, 5\.28 : 1/ })
    ).toBeInTheDocument();
  });

  it('never rounds a failing ratio up to the threshold it fails', () => {
    // rgb(100 123 125) on white is 4.4956:1 — rounding would print 4.50 next to "Fail".
    render(
      <ColorPicker
        value="#647b7d"
        contrastContext={{ backgroundColor: '#ffffff', category: 'normal-text' }}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Fail AA, 4.5:1 required');
    expect(
      screen.getByRole('button', { name: /Contrast color pair, 4\.49 : 1/ })
    ).toBeInTheDocument();
  });

  it('exposes the primary format fields', () => {
    renderPicker('rgba(10, 20, 30, 0.5)');
    expect(screen.getByRole('tab', { name: 'RGB' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('R')).toHaveValue('10');
    expect(screen.getByLabelText('G')).toHaveValue('20');
    expect(screen.getByLabelText('B')).toHaveValue('30');

    fireEvent.click(screen.getByRole('tab', { name: 'HSL' }));
    expect(screen.getByLabelText('H')).toBeInTheDocument();
    expect(screen.getByLabelText('L')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Hex' }));
    expect(screen.getByLabelText('Hex')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Alpha' })).toHaveValue('50%');

    fireEvent.click(screen.getByRole('tab', { name: 'RGB' }));
    expect(screen.getByLabelText('R')).toHaveValue('10');
    expect(screen.getByLabelText('G')).toHaveValue('20');
    expect(screen.getByLabelText('B')).toHaveValue('30');

    fireEvent.click(screen.getByRole('tab', { name: 'HSB' }));
    expect(screen.getByLabelText('S')).toBeInTheDocument();
    expect(screen.getByLabelText('B')).toBeInTheDocument();
  });

  it('emits the CSS syntax selected in the format control', () => {
    const { onChange } = renderPicker('#ff0000');

    fireEvent.click(screen.getByRole('tab', { name: 'Hex' }));
    expect(onChange).toHaveBeenLastCalledWith('#ff0000');

    fireEvent.click(screen.getByRole('tab', { name: 'RGB' }));
    expect(onChange).toHaveBeenLastCalledWith('rgb(255, 0, 0)');

    fireEvent.click(screen.getByRole('tab', { name: 'HSL' }));
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
    expect(screen.getByLabelText('L')).toHaveProperty('value', expect.stringMatching(/%$/));

    fireEvent.change(screen.getByLabelText('L'), { target: { value: '50' } });
    fireEvent.blur(screen.getByLabelText('L'));
    expect(screen.getByLabelText('L')).toHaveProperty('value', expect.stringMatching(/%$/));
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Color format: OKLCH' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'RGB' }));
    expect(screen.getByRole('tab', { name: 'RGB' })).toHaveAttribute('aria-selected', 'true');
  });

  it('scrubs OKLCH chroma with a step matched to its smaller range', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    renderPicker('oklch(60% 0.05 250)');

    const chroma = screen.getByLabelText('C');
    if (!(chroma instanceof HTMLInputElement)) throw new Error('Chroma field should be an input');
    const initial = Number(chroma.value);
    const label = chroma
      .closest('.ss-color-picker__field')
      ?.querySelector('.ss-color-picker__field-label');
    expect(label).not.toBeNull();

    fireEvent.pointerDown(label!, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(label!, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(label!, { pointerId: 1 });

    const adjustedField = screen.getByLabelText('C');
    if (!(adjustedField instanceof HTMLInputElement)) {
      throw new Error('Chroma field should be an input');
    }
    const adjusted = Number(adjustedField.value);
    expect(adjusted).toBeGreaterThan(initial);
    expect(adjusted - initial).toBeLessThan(0.05);
  });

  it('resolves a variable against the supplied selector when showing picker swatches', () => {
    render(
      <ColorPicker
        value="var(--background)"
        authoredValue="var(--background)"
        variableSelector=".dark"
        variables={[
          { name: '--background', value: '#ffffff', selector: ':root' },
          { name: '--background', value: '#000000', selector: '.dark' },
        ]}
        onChange={() => undefined}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const selected = screen.getByRole('option', { name: '--background' });
    expect(selected.querySelector('.ss-color-picker__variable-swatch')).toHaveStyle({
      '--picker-swatch-color': 'rgb(0, 0, 0)',
    });
  });

  it('clamps valid channel edits and restores invalid input', () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'RGB' }));
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
    expect(restore).toHaveStyle({ '--picker-swatch-color': 'rgb(255, 0, 0)' });
    fireEvent.click(restore);
    expect(onChange).toHaveBeenLastCalledWith('#ff0000');
  });

  it('keeps hue and saturation across HSB field edits that pass through black', () => {
    const { onChange } = renderControlledPicker('#ff0000');
    fireEvent.click(screen.getByRole('tab', { name: 'HSB' }));
    expect(screen.getByLabelText('H')).toHaveValue('0');
    expect(screen.getByLabelText('S')).toHaveValue('100%');

    // Brightness 0 is black, which has no recoverable hue/saturation in RGB:
    // the fields must keep showing the HSB the user is editing.
    const brightness = screen.getByLabelText('B');
    fireEvent.change(brightness, { target: { value: '0' } });
    fireEvent.blur(brightness);
    expect(onChange).toHaveBeenLastCalledWith('rgb(0, 0, 0)');
    expect(screen.getByLabelText('H')).toHaveValue('0');
    expect(screen.getByLabelText('S')).toHaveValue('100%');

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
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^rgb/));
  });

  it('copies the selected CSS representation and uses RGB for HSB', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPicker('#ff0000');

    fireEvent.click(screen.getByRole('tab', { name: 'RGB' }));
    fireEvent.click(screen.getByRole('button', { name: /Copy color|Copied color/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('rgb(255, 0, 0)'));
    expect(screen.getByRole('button', { name: 'Copied color' })).toHaveAttribute(
      'data-copied',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Copied color' })).toHaveClass('is-copied');

    fireEvent.click(screen.getByRole('tab', { name: 'HSB' }));
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
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#00ff00'));
  });

  it('uses the native color sampler when the browser EyeDropper is unavailable', async () => {
    mockInvokeResponse('get_color_sampler_support', { available: true, reason: null });
    mockInvokeResponse('sample_screen_color', '#00ff00');
    const { onChange } = renderPicker();
    const button = screen.getByRole('button', { name: 'Eyedropper' });

    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#00ff00'));
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

  it('shows white and black for empty Recent and records a selection', () => {
    window.localStorage.removeItem(recentFallbackStorageKey);
    const onChange = vi.fn();
    render(
      <ColorPicker
        value="#ff0000"
        onChange={onChange}
        onClose={() => undefined}
        projectPath={recentFallbackProjectPath}
      />
    );

    expect(screen.queryByText('No recent colors yet.')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(recentFallbackStorageKey)).toBeNull();
    const white = screen.getByRole('button', { name: 'Use recent color #ffffff' });
    expect(white.querySelector('.ss-color-picker__recent-swatch')).toHaveStyle({
      '--picker-swatch-color': '#ffffff',
    });
    const black = screen.getByRole('button', { name: 'Use recent color #000000' });
    expect(black.querySelector('.ss-color-picker__recent-swatch')).toHaveStyle({
      '--picker-swatch-color': '#000000',
    });

    fireEvent.click(white);

    expect(onChange).toHaveBeenLastCalledWith('#ffffff');
    expect(JSON.parse(window.localStorage.getItem(recentFallbackStorageKey) ?? '[]')).toEqual([
      'rgb(255, 255, 255)',
    ]);
    expect(screen.getByRole('button', { name: 'Use recent color #ffffff' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Use recent color #000000' })
    ).not.toBeInTheDocument();
  });
});
