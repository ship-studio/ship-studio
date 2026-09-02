import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextField } from './TextField';

describe('TextField', () => {
  it('forwards input behavior and supports the compact suffix slot', () => {
    render(<TextField aria-label="Width" defaultValue="auto" suffix="px" />);

    const field = screen.getByRole('textbox', { name: 'Width' });
    expect(field).toHaveValue('auto');
    expect(screen.getByText('px')).toBeInTheDocument();

    fireEvent.change(field, { target: { value: '480' } });
    expect(field).toHaveValue('480');
  });

  it('exposes invalid state through a stable class', () => {
    render(<TextField aria-label="Value" invalid />);

    const field = screen.getByRole('textbox', { name: 'Value' });
    expect(field).toHaveClass('ss-text-field--invalid');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('preserves native disabled and placeholder behavior', () => {
    render(<TextField aria-label="Command" placeholder="npm run dev" disabled />);

    const field = screen.getByRole('textbox', { name: 'Command' });
    expect(field).toBeDisabled();
    expect(field).toHaveAttribute('placeholder', 'npm run dev');
  });

  it('allows a caller-provided aria-invalid value without changing the class contract', () => {
    render(<TextField aria-label="Value" aria-invalid="grammar" />);

    const field = screen.getByRole('textbox', { name: 'Value' });
    expect(field).not.toHaveClass('ss-text-field--invalid');
    expect(field).toHaveAttribute('aria-invalid', 'grammar');
  });
});
