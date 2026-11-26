import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { DockablePanel } from './DockablePanel';
import { ModalFrame } from './ModalFrame';

const mocks = vi.hoisted(() => ({
  logError: vi.fn<(error: Error, context: Record<string, unknown>, source?: string) => void>(),
}));

vi.mock('../../lib/logger', () => ({
  logger: { logError: mocks.logError, error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** Throws the same TypeError shape #1211 reported, until `crash.on` is cleared. */
const crash = { on: true };
function Fragile() {
  if (crash.on) {
    const items = [undefined] as unknown as Array<{ type: string }>;
    return <>{items.map((item) => item.type)}</>;
  }
  return <p>Recovered content</p>;
}

describe('PanelErrorBoundary', () => {
  beforeEach(() => {
    crash.on = true;
    mocks.logError.mockClear();
    // React logs every caught render error; the assertions below are the point.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains the crash to its own surface and leaves siblings rendering', () => {
    render(
      <div>
        <p>Sibling panel</p>
        <PanelErrorBoundary panel="variables" label="Variables panel">
          <Fragile />
        </PanelErrorBoundary>
      </div>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Variables panel crashed');
    expect(screen.getByText('Sibling panel')).toBeInTheDocument();
  });

  it('reports the crash with its component stack and which panel it was', () => {
    render(
      <PanelErrorBoundary panel="variables" label="Variables panel">
        <Fragile />
      </PanelErrorBoundary>
    );

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [error, context, source] = mocks.logError.mock.calls[0];
    expect(error).toBeInstanceOf(TypeError);
    expect(source).toBe('frontend-crash');
    expect(context.panel).toBe('variables');
    expect(context.componentStack).toContain('Fragile');
  });

  it('re-renders its children on Retry', () => {
    render(
      <PanelErrorBoundary panel="variables">
        <Fragile />
      </PanelErrorBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This panel crashed');

    crash.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });

  it('offers Close only when the surface can be dismissed', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <PanelErrorBoundary panel="a">
        <Fragile />
      </PanelErrorBoundary>
    );
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    rerender(
      <PanelErrorBoundary panel="a" onDismiss={onDismiss}>
        <Fragile />
      </PanelErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('is built into DockablePanel, tagged with the rail panel id', () => {
    render(
      <>
        <p>Preview still here</p>
        <DockablePanel
          docked={false}
          ariaLabel="Variables panel"
          positionKey="t.position"
          sizeKey="t.size"
          floatingSize={{ width: 320, height: 400 }}
          initialPosition={() => ({ left: 0, top: 0 })}
        >
          <Fragile />
        </DockablePanel>
      </>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Variables panel crashed');
    expect(screen.getByText('Preview still here')).toBeInTheDocument();
    expect(mocks.logError.mock.calls[0][1].panel).toBe('Variables panel');
  });

  it('is built into ModalFrame: the header survives and Close closes the dialog', () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <p>App behind the modal</p>
          <ModalFrame isOpen={open} onClose={() => setOpen(false)} title="Settings">
            <Fragile />
          </ModalFrame>
        </>
      );
    }
    render(<Host />);

    expect(screen.getByRole('alert')).toHaveTextContent('“Settings” crashed');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
    expect(mocks.logError.mock.calls[0][1].panel).toBe('modal:Settings');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('App behind the modal')).toBeInTheDocument();
  });
});
