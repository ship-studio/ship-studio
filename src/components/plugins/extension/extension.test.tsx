import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ExtensionListRow,
  ExtensionManagerLayout,
  ExtensionSearchField,
  ExtensionState,
  ScopeBadge,
} from './index';

describe('extension management primitives', () => {
  it('keeps the search field controlled and forwards input changes', () => {
    const onChange = vi.fn();

    render(
      <ExtensionSearchField
        aria-label="Filter extensions"
        placeholder="Filter..."
        value="mcp"
        onChange={onChange}
      />
    );

    const input = screen.getByRole('textbox', { name: 'Filter extensions' });
    expect(input).toHaveValue('mcp');

    fireEvent.change(input, { target: { value: 'skills' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders scope semantics without coupling to a domain row', () => {
    render(
      <ExtensionListRow action={<button type="button">Remove</button>}>
        <span>Example extension</span>
        <ScopeBadge scope="project" />
      </ExtensionListRow>
    );

    expect(screen.getByText('Example extension')).toBeInTheDocument();
    expect(screen.getByText('project')).toHaveClass('extension-scope-badge--project');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('gives loading, empty, and error states stable semantic contracts', () => {
    const { rerender } = render(
      <ExtensionState kind="loading" loadingLabel="Loading extensions">
        Loading extensions...
      </ExtensionState>
    );

    expect(screen.getByRole('status', { name: 'Loading extensions' })).toBeInTheDocument();
    expect(screen.getByText('Loading extensions...')).toBeInTheDocument();

    rerender(<ExtensionState kind="empty">No extensions found.</ExtensionState>);
    expect(screen.getByText('No extensions found.')).toBeInTheDocument();

    rerender(<ExtensionState kind="error">Could not load extensions.</ExtensionState>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load extensions.');
  });

  it('keeps tabs, controls, panels, and footer in stable layout slots', () => {
    render(
      <ExtensionManagerLayout
        tabs={<span>Tabs</span>}
        controls={<span>Controls</span>}
        footer={<span>Footer</span>}
      >
        <span>Panel</span>
      </ExtensionManagerLayout>
    );

    expect(screen.getByText('Tabs').parentElement).toHaveClass('extension-manager-layout__tabs');
    expect(screen.getByText('Controls').parentElement).toHaveClass(
      'extension-manager-layout__controls'
    );
    expect(screen.getByText('Panel').parentElement).toHaveClass('extension-manager-layout__panels');
    expect(screen.getByText('Footer').parentElement).toHaveClass(
      'extension-manager-layout__footer'
    );
  });
});
