import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VariableRow } from '../../hooks/useCssVariables';
import type { CssVariableDeleteImpact } from '../../lib/edit-css';
import { CssVariablesPanel } from './CssVariablesPanel';

vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }
);

function renderPanel(variable: VariableRow, onSetValue = vi.fn()) {
  const impact: CssVariableDeleteImpact = {
    usageCount: 0,
    ruleCount: 0,
    fileCount: 0,
    definitionCount: 1,
    replacementValue: '',
  };
  render(
    <CssVariablesPanel
      variables={[variable]}
      loading={false}
      variableNames={[variable.name, '--surface']}
      onSetValue={onSetValue}
      onAddVariable={vi.fn()}
      onAnalyzeDelete={vi.fn().mockResolvedValue(impact)}
      onDeleteVariable={vi.fn().mockResolvedValue(impact)}
    />
  );
  return onSetValue;
}

function editableValue() {
  return document.querySelector<HTMLElement>('.ss-var-row__value.property-field')!;
}

describe('CssVariablesPanel inline value editing', () => {
  it('uses the shared wrapping editor, embeds the color swatch, and preserves commit and cancel', () => {
    const variable: VariableRow = {
      name: '--accent',
      value: '#009c52',
      selector: ':root',
      file: 'styles.css',
      line: 1,
      editable: true,
    };
    const onSetValue = renderPanel(variable);

    fireEvent.click(editableValue());
    const input = screen.getByRole<HTMLTextAreaElement>('combobox');
    const editor = input.closest('.ss-value-pop--inline');
    const field = input.closest('.ss-value-pop__field');
    const swatch = screen.getByRole('button', { name: 'Open color picker' });

    expect(editableValue()).toHaveAttribute('aria-hidden', 'true');
    expect(editableValue()).toHaveAttribute('tabindex', '-1');
    expect(editor?.parentElement).toHaveClass('ss-var-row__value-group--editable');
    expect(input.tagName).toBe('TEXTAREA');
    expect(editor).toHaveClass('ss-value-pop--inline-has-swatch');
    expect(field).toContainElement(swatch);
    expect(swatch).toHaveClass('ss-decl__swatch-trigger', 'ss-var-row__swatch--editor');

    fireEvent.change(input, { target: { value: '#0066cc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSetValue).toHaveBeenCalledWith(variable, '#0066cc');

    fireEvent.click(editableValue());
    const cancelInput = screen.getByRole<HTMLTextAreaElement>('combobox');
    fireEvent.change(cancelInput, { target: { value: '#ff0000' } });
    fireEvent.keyDown(cancelInput, { key: 'Escape' });

    expect(onSetValue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('routes the embedded swatch to the color picker', () => {
    const variable: VariableRow = {
      name: '--accent',
      value: '#009c52',
      selector: ':root',
      file: 'styles.css',
      line: 1,
      editable: true,
    };
    renderPanel(variable);

    fireEvent.click(editableValue());
    fireEvent.click(screen.getByRole('button', { name: 'Open color picker' }));

    expect(screen.getByRole('dialog', { name: 'Color picker' })).toBeInTheDocument();
  });

  it('carries an uncommitted variable draft into the color picker', () => {
    const variable: VariableRow = {
      name: '--accent',
      value: '#009c52',
      selector: ':root',
      file: 'styles.css',
      line: 1,
      editable: true,
    };
    renderPanel(variable);

    fireEvent.click(editableValue());
    const input = screen.getByRole<HTMLTextAreaElement>('combobox');
    fireEvent.change(input, { target: { value: '#0066cc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open color picker' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Hex' }));
    expect(screen.getByLabelText('Hex')).toHaveValue('#0066cc');
  });

  it('keeps variable autocomplete and arrow-key selection in the shared editor', () => {
    const variable: VariableRow = {
      name: '--space',
      value: '8px',
      selector: ':root',
      file: 'styles.css',
      line: 1,
      editable: true,
    };
    const onSetValue = renderPanel(variable);

    fireEvent.click(editableValue());
    const input = screen.getByRole<HTMLTextAreaElement>('combobox');
    fireEvent.change(input, { target: { value: 'var(--sur' } });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSetValue).toHaveBeenCalledWith(variable, 'var(--surface)');
  });

  it('edits scoped values with the shared row and keeps root-only delete actions hidden', () => {
    const variable: VariableRow = {
      name: '--accent',
      value: 'var(--brand)',
      selector: '.theme-dark',
      file: 'styles.css',
      line: 14,
      editable: true,
    };
    const onSetValue = renderPanel(variable);

    expect(screen.getByText('.theme-dark')).toBeInTheDocument();
    expect(screen.getByText('scoped tokens')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for --accent' })).not.toBeInTheDocument();

    fireEvent.click(editableValue());
    const input = screen.getByRole<HTMLTextAreaElement>('combobox');
    fireEvent.change(input, { target: { value: '1.5rem' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSetValue).toHaveBeenCalledWith(variable, '1.5rem');
  });

  it('keeps an ambiguous duplicate source identity read-only', () => {
    const variable: VariableRow = {
      name: '--accent',
      value: 'green',
      selector: '.theme-dark',
      file: 'styles.css',
      line: 14,
      editable: false,
    };
    renderPanel(variable);

    expect(document.querySelector('.ss-var-row')).toHaveClass('is-readonly');
    expect(document.querySelector('.ss-var-row__value.property-field')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for --accent' })).not.toBeInTheDocument();
  });
});
