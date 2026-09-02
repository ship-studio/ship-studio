import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ValueField, parseValueFieldVariable, splitValueFieldValue } from './ValueField';

describe('ValueField', () => {
  it('renders a leading control inside the field before the editable value', () => {
    render(
      <ValueField
        aria-label="Color value"
        variant="color"
        value="#e2f8fd"
        leading={
          <button type="button" aria-label="Color swatch">
            swatch
          </button>
        }
        onCommit={vi.fn()}
      />
    );

    const input = screen.getByRole('textbox', { name: 'Color value' });
    const leading = screen.getByRole('button', { name: 'Color swatch' });

    expect(leading.parentElement).toHaveClass('value-field__leading');
    expect(input.previousElementSibling).toBe(leading.parentElement);
  });

  it('keeps the format menu open when activated from the focused input', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Width" variant="length" value="12px" onCommit={onCommit} />);

    const input = screen.getByRole('textbox', { name: 'Width' });
    const trigger = screen.getByRole('button', { name: 'Width format' });
    await user.click(input);
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Width formats' })).toBeVisible();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not close when a delayed pointer click follows the pointerdown toggle', async () => {
    render(<ValueField aria-label="Width" variant="length" value="12px" onCommit={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Width format' });
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    // Some WebKit paths report the delayed pointer click with zero detail.
    fireEvent.click(trigger, { detail: 0 });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Width formats' })).toBeVisible();
  });

  it('splits a typed unit from the editable magnitude on Enter', () => {
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Width" variant="length" value="auto" onCommit={onCommit} />);

    const input = screen.getByRole('textbox', { name: 'Width' });
    fireEvent.change(input, { target: { value: '12px' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('12px');
    expect(input).toHaveValue('12');
    expect(screen.getByRole('button', { name: 'Width format' })).toHaveTextContent('PX');
  });

  it('splits a recognized unit while typing instead of leaving it in the field', () => {
    render(<ValueField aria-label="Size" variant="length" value="" onCommit={vi.fn()} />);

    const input = screen.getByRole('textbox', { name: 'Size' });
    fireEvent.change(input, { target: { value: '1rem' } });

    expect(input).toHaveValue('1');
    expect(screen.getByRole('button', { name: 'Size format' })).toHaveTextContent('REM');
  });

  it('splits a recognized unit from an initial controlled value', () => {
    render(
      <ValueField aria-label="Letter spacing" variant="length" value="0em" onCommit={vi.fn()} />
    );

    expect(screen.getByRole('textbox', { name: 'Letter spacing' })).toHaveValue('0');
    expect(screen.getByRole('button', { name: 'Letter spacing format' })).toHaveTextContent('EM');
  });

  it('splits a unit-bearing placeholder into its magnitude and format trigger', () => {
    const onCommit = vi.fn();
    render(
      <ValueField
        aria-label="Size"
        variant="length"
        value=""
        placeholder="1rem"
        onCommit={onCommit}
      />
    );

    const input = screen.getByRole('textbox', { name: 'Size' });
    expect(input).toHaveAttribute('placeholder', '1');
    expect(screen.getByRole('button', { name: 'Size format' })).toHaveTextContent('REM');

    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('changes the format without changing the magnitude', () => {
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Height" variant="length" value="24px" onCommit={onCommit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Height format' }));
    fireEvent.click(screen.getByRole('option', { name: '%' }));

    expect(onCommit).toHaveBeenCalledWith('24%');
    expect(screen.getByRole('textbox', { name: 'Height' })).toHaveValue('24');
    expect(screen.getByRole('button', { name: 'Height format' })).toHaveTextContent('%');
  });

  it('focuses the selected option and supports listbox keyboard selection', () => {
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={onCommit} />);

    const trigger = screen.getByRole('button', { name: 'Width format' });
    fireEvent.click(trigger);

    const selected = screen.getByRole('option', { name: 'PX' });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected).toHaveFocus();

    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    const percent = screen.getByRole('option', { name: '%' });
    expect(percent).toHaveFocus();

    fireEvent.keyDown(percent, { key: 'End' });
    const last = screen.getByRole('option', { name: 'SVH' });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Home' });
    const empty = screen.getByRole('option', { name: '-' });
    expect(empty).toHaveFocus();

    fireEvent.keyDown(empty, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('option', { name: 'PX' }), { key: 'ArrowDown' });
    fireEvent.keyDown(percent, { key: ' ' });
    expect(onCommit).toHaveBeenCalledWith('24%');
    expect(screen.getByRole('textbox', { name: 'Width' })).toHaveFocus();
  });

  it('opens from the trigger keyboard and restores trigger focus on Escape', () => {
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Width format' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const selected = screen.getByRole('option', { name: 'PX' });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('dismisses the portaled listbox on an outside pointer event', async () => {
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Width format' }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps unsupported and complex values intact', () => {
    expect(splitValueFieldValue('clamp(10px, 5vw, 20rem)', [])).toEqual({
      text: 'clamp(10px, 5vw, 20rem)',
      unit: '',
    });
  });

  it('displays a CSS variable without the var() wrapper and marks its unit as VAR', () => {
    render(
      <ValueField
        aria-label="Width"
        variant="length"
        value="var(--space-lg)"
        variables={[{ name: '--space-lg', value: '24px' }]}
        onCommit={vi.fn()}
      />
    );

    expect(screen.getByRole('combobox', { name: 'Width' })).toHaveValue('--space-lg');
    expect(screen.getByRole('button', { name: 'Width format' })).toHaveTextContent('VAR');
    expect(screen.getByRole('combobox', { name: 'Width' }).closest('.value-field')).toHaveClass(
      'value-field--variable'
    );
    expect(parseValueFieldVariable('var(--space-lg)')).toBe('--space-lg');
  });

  it('opens all variables on focus and commits a picked raw name as var()', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn(() => true);
    render(
      <ValueField
        aria-label="Width"
        variant="length"
        value="var(--space-lg)"
        variables={[
          { name: '--space-sm', value: '8px' },
          { name: '--space-lg', value: '24px' },
        ]}
        onCommit={onCommit}
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Width' }));
    expect(screen.getByRole('listbox', { name: 'Width variables' })).toBeVisible();
    await user.click(screen.getByRole('option', { name: /--space-sm/ }));

    expect(onCommit).toHaveBeenCalledWith('var(--space-sm)');
    expect(screen.getByRole('combobox', { name: 'Width' })).toHaveValue('--space-sm');
  });

  it('opens and filters variables after typing --, including after switching from a unit', () => {
    const onCommit = vi.fn(() => true);
    render(
      <ValueField
        aria-label="Width"
        variant="length"
        value="12px"
        variables={[
          { name: '--layout-gutter', value: '24px' },
          { name: '--space-sm', value: '8px' },
        ]}
        onCommit={onCommit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Width format' }));
    fireEvent.click(screen.getByRole('option', { name: 'VAR' }));

    const input = screen.getByRole('combobox', { name: 'Width' });
    expect(input).toHaveValue('--');
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.change(input, { target: { value: '--layout' } });
    expect(screen.getByRole('option', { name: /--layout-gutter/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /--space-sm/ })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('var(--layout-gutter)');
  });

  it('constrains the variable picker to its padded panel boundary', () => {
    render(
      // inline-style-ok: the padding under test — the fixture exists to prove the
      // menu clamps to a padded boundary, so the value must live here, not in a class.
      <div data-value-field-menu-boundary style={{ paddingLeft: '12px', paddingRight: '12px' }}>
        <ValueField
          aria-label="Width"
          variant="length"
          value="var(--space-lg)"
          variables={[{ name: '--space-lg', value: '24px' }]}
          onCommit={vi.fn()}
        />
      </div>
    );

    const boundary = screen.getByRole('combobox', { name: 'Width' }).parentElement
      ?.parentElement as HTMLDivElement;
    const field = screen.getByRole('combobox', { name: 'Width' }).closest('.value-field');
    vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 340,
      width: 240,
    } as DOMRect);
    vi.spyOn(field as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left: 220,
      right: 328,
      bottom: 80,
      width: 108,
    } as DOMRect);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Width' }));

    expect(screen.getByRole('listbox', { name: 'Width variables' })).toHaveStyle({
      left: '112px',
      width: '216px',
    });
  });
  it('hides the unit trigger for a plain number field with nothing to choose', () => {
    render(
      <ValueField aria-label="Opacity value" variant="number" value="100" onCommit={vi.fn()} />
    );

    // The number variant's only option is the empty "no unit" entry, which
    // used to render as a stray "-" beside the value (Opacity read "100 -").
    expect(screen.queryByRole('button', { name: 'Opacity value format' })).toBeNull();
  });

  it('keeps the unit trigger when the field actually has units', () => {
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Width format' })).toHaveTextContent('PX');
  });
});
