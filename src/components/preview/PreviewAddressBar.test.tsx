import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewAddressBar } from './PreviewAddressBar';

describe('PreviewAddressBar', () => {
  it('saves another loopback dev server through the saved URL flow', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <PreviewAddressBar
        value="http://localhost:3000/"
        savedUrls={[]}
        defaultUrl="http://localhost:3000/"
        onNavigate={vi.fn()}
        onSave={onSave}
        onRemove={vi.fn()}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose a saved preview URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save another URL…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Another dev server address…' }));
    const devServerInput = screen.getByLabelText('Another dev server address');
    expect(devServerInput).toHaveValue('http://localhost:');
    fireEvent.change(screen.getByLabelText('Another dev server address'), {
      target: { value: 'http://localhost:5173/custom/path' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save URL' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('http://localhost:5173/custom/path'));

    fireEvent.click(screen.getByRole('button', { name: 'Choose a saved preview URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save another URL…' }));
    fireEvent.click(screen.getByRole('button', { name: 'External URL…' }));
    expect(screen.getByLabelText('External URL')).toHaveValue('');
  });
});
