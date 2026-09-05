import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModalFrame } from './ModalFrame';
import { ToastList } from './ToastList';

describe('ModalFrame', () => {
  it('renders the standard close button for titled dialogs', () => {
    const onClose = vi.fn();

    render(
      <ModalFrame isOpen onClose={onClose} title="Example dialog">
        <button type="button">Continue</button>
      </ModalFrame>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels the dialog, focuses its first control, and restores the opener', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open dialog</button>
        <ModalFrame isOpen={false} onClose={onClose} title="Example dialog" showCloseButton={false}>
          <button type="button">Continue</button>
        </ModalFrame>
      </>
    );

    const opener = screen.getByRole('button', { name: 'Open dialog' });
    opener.focus();

    rerender(
      <>
        <button type="button">Open dialog</button>
        <ModalFrame isOpen onClose={onClose} title="Example dialog" showCloseButton={false}>
          <button type="button">Continue</button>
        </ModalFrame>
      </>
    );

    const dialog = screen.getByRole('dialog', { name: 'Example dialog' });
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId ?? '')).toHaveTextContent('Example dialog');
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();

    rerender(
      <>
        <button type="button">Open dialog</button>
        <ModalFrame isOpen={false} onClose={onClose} title="Example dialog" showCloseButton={false}>
          <button type="button">Continue</button>
        </ModalFrame>
      </>
    );

    expect(opener).toHaveFocus();
  });

  it('wraps keyboard focus at both ends of the dialog', () => {
    render(
      <ModalFrame isOpen onClose={vi.fn()} ariaLabel="Focus trap" showCloseButton={false}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </ModalFrame>
    );

    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('only dismisses the topmost modal when Escape is allowed', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ModalFrame isOpen onClose={onClose} ariaLabel="Dismissable dialog" showCloseButton={false}>
        <button type="button">Action</button>
      </ModalFrame>
    );

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Dismissable dialog' }), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <ModalFrame
        isOpen
        onClose={onClose}
        ariaLabel="Busy dialog"
        dismissable={false}
        showCloseButton={false}
      >
        <button type="button">Action</button>
      </ModalFrame>
    );

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Busy dialog' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the first Escape to a nested control and closes on the second', () => {
    const onClose = vi.fn();
    const onCancelEdit = vi.fn();
    render(
      <ModalFrame isOpen onClose={onClose} ariaLabel="Rename dialog" showCloseButton={false}>
        <input
          aria-label="New name"
          defaultValue="draft"
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancelEdit();
          }}
        />
      </ModalFrame>
    );

    const input = screen.getByRole('textbox', { name: 'New name' });
    input.focus();

    // The inline rename cancels; the dialog must not unmount it mid-edit.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // Second press falls through to the dialog, so it can't get stuck open.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honours a nested handler that claims Escape outright', () => {
    const onClose = vi.fn();
    render(
      <ModalFrame isOpen onClose={onClose} ariaLabel="Menu dialog" showCloseButton={false}>
        <button type="button" onKeyDown={(event) => event.stopPropagation()}>
          Claiming control
        </button>
      </ModalFrame>
    );

    const control = screen.getByRole('button', { name: 'Claiming control' });
    fireEvent.keyDown(control, { key: 'Escape' });
    fireEvent.keyDown(control, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps toasts interactive while a dialog is open', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <ToastList toasts={[{ id: 7, message: 'Saved', type: 'success' }]} onDismiss={onDismiss} />
        <ModalFrame isOpen onClose={vi.fn()} ariaLabel="Blocking dialog" showCloseButton={false}>
          <button type="button">Action</button>
        </ModalFrame>
      </>
    );

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.closest('[inert]')).toBeNull();
    expect(dismiss.closest('[aria-hidden="true"]')).toBeNull();

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledWith(7);
  });

  it('dismisses on an overlay click without treating content clicks as outside clicks', () => {
    const onClose = vi.fn();
    render(
      <ModalFrame isOpen onClose={onClose} ariaLabel="Overlay dialog" showCloseButton={false}>
        <button type="button">Content action</button>
      </ModalFrame>
    );

    const overlay = document.querySelector<HTMLElement>('[data-modal-id]');
    const content = screen.getByRole('dialog', { name: 'Overlay dialog' });
    expect(overlay).not.toBeNull();

    fireEvent.mouseDown(content);
    fireEvent.click(content);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(overlay!);
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('inerts the background and restores body scrolling after close', () => {
    document.body.style.overflow = 'scroll';
    document.body.style.paddingRight = '3px';
    const { container, rerender } = render(
      <>
        <main>Workspace content</main>
        <ModalFrame isOpen onClose={vi.fn()} ariaLabel="Workspace dialog" showCloseButton={false}>
          <button type="button">Close</button>
        </ModalFrame>
      </>
    );

    expect(container).toHaveAttribute('inert');
    expect(container).toHaveAttribute('data-modal-background-inert', 'true');
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <>
        <main>Workspace content</main>
        <ModalFrame
          isOpen={false}
          onClose={vi.fn()}
          ariaLabel="Workspace dialog"
          showCloseButton={false}
        >
          <button type="button">Close</button>
        </ModalFrame>
      </>
    );

    expect(container).not.toHaveAttribute('inert');
    expect(container).not.toHaveAttribute('data-modal-background-inert');
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.body.style.paddingRight).toBe('3px');
  });

  it('keeps the parent inactive while a nested modal is open', () => {
    const onParentClose = vi.fn();

    function NestedModals() {
      const [childOpen, setChildOpen] = useState(true);

      return (
        <ModalFrame isOpen onClose={onParentClose} title="Parent dialog" showCloseButton={false}>
          <button type="button">Parent action</button>
          <ModalFrame
            isOpen={childOpen}
            onClose={() => setChildOpen(false)}
            title="Child dialog"
            showCloseButton={false}
          >
            <button type="button">Child action</button>
          </ModalFrame>
        </ModalFrame>
      );
    }

    render(<NestedModals />);

    const parentDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
      (dialog) => dialog.textContent?.includes('Parent dialog')
    );
    const childDialog = screen.getByRole('dialog', { name: 'Child dialog' });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(parentDialog).toBeDefined();
    expect(parentDialog).toHaveAttribute('aria-hidden', 'true');
    expect(parentDialog?.parentElement).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Child action' })).toHaveFocus();

    fireEvent.keyDown(childDialog, { key: 'Escape' });

    expect(onParentClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Child dialog' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent dialog' })).not.toHaveAttribute(
      'aria-hidden'
    );
  });
});
