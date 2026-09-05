import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MediaQueryChips } from './MediaQueryChips';

describe('MediaQueryChips', () => {
  it('renders the query as individually addressable chunks', () => {
    render(<MediaQueryChips condition="screen and (max-width: 767px)" />);

    expect(document.querySelector('[data-query-chunk-kind="at-rule"]')).toHaveTextContent('@media');
    expect(document.querySelector('[data-query-chunk-kind="type"]')).toHaveTextContent('screen');
    expect(document.querySelector('[data-query-chunk-kind="operator"]')).toHaveTextContent('and');
    expect(document.querySelector('[data-query-chunk-kind="operator"]')).not.toHaveClass(
      'ss-media-query__chunk--joined-before'
    );
    expect(document.querySelector('[data-query-chunk-kind="feature"]')).toHaveTextContent(
      'max-width:'
    );
    expect(document.querySelector('[data-query-chunk-kind="value"]')).toHaveTextContent('767px');
  });

  it('edits one chunk and offers suggestions for its vocabulary', async () => {
    const onCommit = vi.fn();
    render(<MediaQueryChips condition="screen and (max-width: 767px)" onCommit={onCommit} />);

    fireEvent.click(screen.getByRole('button', { name: 'screen' }));
    expect(screen.getByRole('combobox', { name: 'Edit media query type' })).toHaveValue('screen');
    expect(screen.getByRole('option', { name: 'all' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'speech' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'print' }).querySelector('code')).toHaveAttribute(
      'data-suggestion-tone',
      'property'
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Edit media query type' }), {
      target: { value: 'pr' },
    });
    expect(screen.getByRole('option', { name: 'print' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Edit media query type' }), {
      target: { value: 'print' },
    });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Edit media query type' }), {
      key: 'Enter',
    });

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('print and (max-width: 767px)'));
  });

  it('focuses a trailing caret and lets Backspace remove existing chunks', () => {
    render(<MediaQueryChips condition="screen and (max-width: 767px)" onCommit={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Media query: screen and (max-width: 767px)'));
    const tail = screen.getByRole('combobox', { name: 'Continue media query' });
    expect(tail).toHaveFocus();
    expect(screen.getByRole('option', { name: 'and' })).toBeInTheDocument();

    fireEvent.keyDown(tail, { key: 'Backspace' });
    expect(document.querySelector('[data-query-chunk-kind="value"]')).not.toBeInTheDocument();
  });

  it('deletes an existing chunk when its editor is emptied', async () => {
    render(<MediaQueryChips condition="screen and (max-width: 767px)" onCommit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'screen' }));
    const editor = screen.getByRole('combobox', { name: 'Edit media query type' });
    fireEvent.change(editor, { target: { value: '' } });
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(document.querySelector('[data-query-chunk-kind="type"]')).not.toBeInTheDocument()
    );
    expect(screen.getByRole('combobox', { name: 'Continue media query' })).toHaveFocus();
  });

  it('renders a free-typed feature value with the media value tone', () => {
    render(<MediaQueryChips condition="(max-width:)" onCommit={vi.fn()} />);

    const tail = screen.getByRole('combobox', { name: 'Continue media query' });
    fireEvent.focus(tail);
    fireEvent.change(tail, { target: { value: '934px' } });
    fireEvent.keyDown(tail, { key: 'Enter' });

    const value = document.querySelector('[data-query-chunk-kind="value"]');
    expect(value).toHaveTextContent('934px');
    expect(value).toHaveAttribute('data-tone', 'media');
  });

  it('colours value suggestions to match their resulting pink tags', () => {
    render(<MediaQueryChips condition="(max-width: 767px)" onCommit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '767px' }));

    const option = screen.getByRole('option', { name: '320px' });
    expect(option.querySelector('code')).toHaveAttribute('data-suggestion-tone', 'media');
  });
});
