import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_COLORS } from '../../lib/accounts';
import { AccountColorPicker } from './AccountColorPicker';

describe('AccountColorPicker', () => {
  it('renders the shared palette and reports the selected color', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AccountColorPicker value={ACCOUNT_COLORS[1]} onChange={onChange} />);

    const selected = screen.getByRole('button', {
      name: `Use ${ACCOUNT_COLORS[1]} as the workspace color`,
    });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button')).toHaveLength(ACCOUNT_COLORS.length);

    await user.click(
      screen.getByRole('button', {
        name: `Use ${ACCOUNT_COLORS[2]} as the workspace color`,
      })
    );
    expect(onChange).toHaveBeenCalledWith(ACCOUNT_COLORS[2]);
  });
});
