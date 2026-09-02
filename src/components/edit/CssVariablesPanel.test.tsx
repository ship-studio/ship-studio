import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVariablesPanel } from './CssVariablesPanel';

vi.mock('./EditPopover', () => ({
  EditPopover: ({
    enableColorPicker,
    onClose,
  }: {
    enableColorPicker?: boolean;
    onClose: () => void;
  }) => (
    <div data-testid="edit-popover" data-color-picker={enableColorPicker ? 'true' : 'false'}>
      <button type="button" onClick={onClose}>
        Close editor
      </button>
    </div>
  ),
}));

describe('CssVariablesPanel', () => {
  it('analyzes impact before confirming variable deletion', async () => {
    const variable = {
      name: '--space-sm',
      value: '8px',
      selector: ':root',
      file: 'styles.css',
      line: 1,
      editable: true,
    };
    const impact = {
      usageCount: 3,
      ruleCount: 2,
      fileCount: 1,
      definitionCount: 1,
      replacementValue: '8px',
    };
    const onAnalyzeDelete = vi.fn().mockResolvedValue(impact);
    const onDeleteVariable = vi.fn().mockResolvedValue(impact);

    render(
      <CssVariablesPanel
        variables={[variable]}
        loading={false}
        variableNames={[variable.name]}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={onAnalyzeDelete}
        onDeleteVariable={onDeleteVariable}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Actions for --space-sm' });
    expect(trigger.querySelector('svg')).toHaveAttribute('width', '14');

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveClass('ss-var-row__menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onAnalyzeDelete).toHaveBeenCalledWith(variable);
    expect(await screen.findByText('3 times')).toBeInTheDocument();
    expect(screen.getByText('2 CSS rules')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete variable' }));
    expect(onDeleteVariable).toHaveBeenCalledWith(variable, impact);
  });

  it('keeps long values in an independently wrapping value cell', () => {
    const longValue =
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

    const { container } = render(
      <CssVariablesPanel
        variables={[
          {
            name: '--font-sans',
            value: longValue,
            selector: ':root',
            file: 'styles.css',
            line: 1,
            editable: true,
          },
          {
            name: '--space-sm',
            value: '8px',
            selector: ':root',
            file: 'styles.css',
            line: 5,
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--font-sans', '--space-sm']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
      />
    );

    const rows = container.querySelectorAll('.ss-var-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.ss-css-value-text')).toHaveTextContent(longValue);
    expect(rows[1]?.querySelector('.ss-css-value-text')).toHaveTextContent('8px');
  });

  it('toggles the picker from the swatch and keeps value editing textual', () => {
    const { container } = render(
      <CssVariablesPanel
        variables={[
          {
            name: '--accent',
            value: '#009c52',
            selector: ':root',
            file: 'styles.css',
            line: 1,
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--accent']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Open color picker' });
    expect(container.querySelector('.ss-var-row__name .ss-var-row__type-icon')).toHaveTextContent(
      '●'
    );
    expect(swatch.parentElement).toHaveClass('ss-var-row__value-group');
    fireEvent.click(swatch);
    expect(screen.getByTestId('edit-popover')).toHaveAttribute('data-color-picker', 'true');

    fireEvent.click(swatch);
    expect(screen.queryByTestId('edit-popover')).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('.ss-var-row__value') as HTMLElement);
    expect(screen.getByTestId('edit-popover')).toHaveAttribute('data-color-picker', 'false');
  });

  it('shows the checkerboard behind a fully transparent color variable', () => {
    render(
      <CssVariablesPanel
        variables={[
          {
            name: '--test-token',
            value: 'hsla(0, 0%, 100%, 0)',
            selector: ':root',
            file: 'styles.css',
            line: 1,
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--test-token']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Open color picker' });
    expect(swatch).toHaveClass('ss-color-swatch__chip--checkerboard');
    expect(swatch.querySelector('.ss-var-row__swatch-color')).toHaveStyle({
      backgroundColor: 'hsla(0, 0%, 100%, 0)',
    });
  });
});
