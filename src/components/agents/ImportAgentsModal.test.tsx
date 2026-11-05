import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ModalProvider } from '../../contexts/ModalContext';
import { ImportAgentsModal } from './ImportAgentsModal';
import type { ImportResult } from './ImportPastePanel';

vi.mock('../../lib/remoteAccess', () => ({
  getRemoteAccessStatus: () => Promise.resolve({ enabled: false }),
}));
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  getImportPrompt: () => Promise.resolve('prompt'),
}));
vi.mock('../../lib/agentsStore', () => ({
  useAgentsList: () => [{ id: 'chief', name: 'Chief of Staff', isMain: true }],
}));
vi.mock('./ImportParts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ImportParts')>()),
  ImportDone: () => <p>Imported</p>,
}));

const RESULT: ImportResult = {
  summary: { created: ['Finance'], updated: [], skipped: [], routinesSet: [], routinesRefused: [] },
  agents: [],
};

// The paste panel's whole job here is to finish: one button that does.
vi.mock('./ImportPastePanel', () => ({
  ImportPastePanel: ({ onDone }: { onDone: (r: ImportResult) => void }) => (
    <button type="button" onClick={() => onDone(RESULT)} onKeyDown={() => onDone(RESULT)}>
      Finish
    </button>
  ),
}));

function renderModal() {
  render(
    <ModalProvider>
      <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={vi.fn()} />
    </ModalProvider>
  );
  return screen.getByRole('button', { name: 'Finish' });
}

describe('ImportAgentsModal done state', () => {
  it('opens quiet after a pointer import: focus on the body, not the button', () => {
    const finish = renderModal();
    act(() => {
      fireEvent.click(finish, { detail: 1 });
    });
    const open = screen.getByRole('button', { name: 'Open Chief of Staff' });
    expect(open).not.toHaveFocus();
    expect(screen.getByText('Imported').closest('.agents-import__body')).toHaveFocus();
  });

  it('focuses Open after a keyboard import', () => {
    const finish = renderModal();
    act(() => {
      fireEvent.keyDown(finish, { key: 'Enter' });
    });
    expect(screen.getByRole('button', { name: 'Open Chief of Staff' })).toHaveFocus();
  });
});
