import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { QuitConfirmModal } from './QuitConfirmModal';

afterEach(() => clearMocks());

const handlers = () => ({ onCancel: vi.fn(), onQuit: vi.fn(), onKeepRunning: vi.fn() });

describe('QuitConfirmModal', () => {
  it('is the plain question when nothing would be interrupted', () => {
    mockIPC(() => ({ enabled: false }));
    const h = handlers();
    render(<QuitConfirmModal {...h} check={{ working: [], waiting: [] }} backgroundAvailable />);
    expect(screen.getByText('Are you sure you want to quit Ship Studio?')).toBeTruthy();
    expect(screen.queryByText('Keep running in background')).toBeNull();
  });

  it('guards a quit while agents work, with keep-running as the default', () => {
    mockIPC(() => ({ enabled: false }));
    const h = handlers();
    render(
      <QuitConfirmModal
        {...h}
        check={{ working: ['Acme', 'Fin'], waiting: [] }}
        backgroundAvailable
      />
    );
    expect(screen.getByText('2 agents are still working. Quit anyway?')).toBeTruthy();
    const keep = screen.getByRole('button', { name: 'Keep running in background' });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(h.onKeepRunning).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
    expect(h.onQuit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onCancel).toHaveBeenCalledOnce();
  });

  it('without background running, Cancel is the default and Return never quits', () => {
    mockIPC(() => ({ enabled: false }));
    const h = handlers();
    render(<QuitConfirmModal {...h} check={{ working: ['Acme'], waiting: [] }} />);
    expect(screen.queryByText('Keep running in background')).toBeNull();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(h.onQuit).not.toHaveBeenCalled();
  });
});
