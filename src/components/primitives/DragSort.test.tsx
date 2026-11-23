import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode, useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DragSortHandle, DragSortItem, DragSortScope, DragSortTarget } from './DragSort';
import { useDragSortContext } from '../../contexts/dragSortContextValue';

function pointer(type: string, x: number, y: number, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

function Example({
  onMove = vi.fn(),
  showTargetIndicator = false,
  handleVisibility = 'always',
}: {
  onMove?: (move: unknown) => void;
  showTargetIndicator?: boolean;
  handleVisibility?: 'always' | 'hover';
}) {
  return (
    <DragSortScope onMove={onMove} label="Panel layout" reducedMotion={() => true}>
      {['a', 'b'].map((id, index) => (
        <DragSortItem
          key={id}
          id={id}
          index={index}
          label={id}
          showTargetIndicator={showTargetIndicator}
          overlay={<span>{id}</span>}
        >
          <span>{id}</span>
          <DragSortHandle visibility={handleVisibility} />
        </DragSortItem>
      ))}
    </DragSortScope>
  );
}

function InsideTargetExample() {
  return (
    <DragSortScope
      reducedMotion={() => true}
      insideHoldDelayMs={50}
      insideHoldFlashDurationMs={25}
      placementForTarget={() => 'inside'}
    >
      {['a', 'b'].map((id, index) => (
        <DragSortItem
          key={id}
          id={id}
          index={index}
          label={id}
          activation="item"
          overlay={<span>{id}</span>}
        >
          <DragSortTarget>
            <span>{id}</span>
          </DragSortTarget>
        </DragSortItem>
      ))}
    </DragSortScope>
  );
}

function ScopeRenderProbe({ onRender }: { onRender: () => void }) {
  useDragSortContext();
  onRender();
  return null;
}

function ManagerCapture({
  capture,
}: {
  capture: (manager: ReturnType<typeof useDragSortContext>['manager']) => void;
}) {
  capture(useDragSortContext().manager);
  return null;
}

function RepaintingOverlayItem({ id, index }: { id: string; index: number }) {
  const { manager } = useDragSortContext();
  // This deliberately creates a fresh overlay node whenever the manager
  // publishes a pointer update. The registration must stay alive while the
  // item binding repaints; otherwise activation unregisters the active item
  // and the visible row vanishes at the source boundary.
  useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  return (
    <DragSortItem
      id={id}
      index={index}
      label={id}
      overlay={<span data-drag-sort-repainting-overlay="true">{id}</span>}
    >
      <span>{id}</span>
      <DragSortHandle />
    </DragSortItem>
  );
}

describe('DragSort primitives', () => {
  it('renders accessible handles and a polite live region', () => {
    render(<Example />);
    const handle = screen.getByRole('button', { name: 'Move a' });
    expect(handle).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('drag-sort-instructions')
    );
    expect(handle).not.toHaveAttribute('data-drag-sort-handle-visibility');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not lift an item when a nested control handles Enter', () => {
    render(
      <DragSortScope reducedMotion={() => true}>
        <DragSortItem id="a" index={0} label="a" activation="item">
          <button type="button">Expand</button>
        </DragSortItem>
      </DragSortScope>
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Expand' }), { key: 'Enter' });

    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('makes item activation a labelled, keyboard-focusable whole-row control', () => {
    render(
      <DragSortScope reducedMotion={() => true} label="Elements">
        <DragSortItem id="a" index={0} label="div element" activation="item">
          <span>div</span>
        </DragSortItem>
      </DragSortScope>
    );

    const item = screen.getByRole('button', { name: 'Move div element' });
    expect(item).toHaveAttribute('tabindex', '0');
    expect(item).toHaveAttribute('aria-roledescription', 'sortable item');
    expect(item).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('drag-sort-instructions')
    );
    item.focus();
    expect(item).toHaveFocus();
  });

  it('starts item activation from row content but ignores interactive descendants', () => {
    let manager: ReturnType<typeof useDragSortContext>['manager'] | undefined;
    const { container } = render(
      <DragSortScope reducedMotion={() => true}>
        <ManagerCapture capture={(value) => (manager = value)} />
        <DragSortItem id="a" index={0} label="a" activation="item">
          <span>content</span>
          <button type="button">Expand</button>
          <span role="tab">Tab</span>
        </DragSortItem>
      </DragSortScope>
    );
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;
    fireEvent.pointerDown(item.querySelector('span:not([role])')!, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
      button: 0,
    });
    expect(manager?.getSnapshot().phase).toBe('pending');
    act(() => manager?.cancel());

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Expand' }), {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
      button: 0,
    });
    expect(manager?.getSnapshot().phase).toBe('idle');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Tab' }), { key: ' ' });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('supports keyboard sorting from the focused item and restores item focus', () => {
    const onMove = vi.fn();
    const { container } = render(
      <DragSortScope reducedMotion={() => true} onMove={onMove}>
        {['a', 'b'].map((id, index) => (
          <DragSortItem key={id} id={id} index={index} label={id} activation="item">
            <span>{id}</span>
          </DragSortItem>
        ))}
      </DragSortScope>
    );
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;
    item.focus();
    fireEvent.keyDown(item, { key: ' ' });
    expect(item).toHaveAttribute('data-drag-sort-dragging', 'true');
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    fireEvent.keyDown(item, { key: ' ' });
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ activeId: 'a' }));
    expect(item).toHaveFocus();
  });

  it('does not arm handle-only items from their row content', () => {
    const { container } = render(<Example />);
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;

    fireEvent(item.querySelector('span')!, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 30));

    expect(item).not.toHaveAttribute('data-drag-sort-dragging');
    expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('keeps hover-revealed handles mounted and reveals them for keyboard focus', () => {
    render(<Example handleVisibility="hover" />);
    const handle = screen.getByRole('button', { name: 'Move a' });
    expect(handle).toHaveAttribute('data-drag-sort-handle-visibility', 'hover');
    expect(handle).toHaveAttribute('data-drag-sort-handle-reveal-on', 'item');
    expect(handle).toHaveAttribute('aria-label', 'Move a');
    handle.focus();
    fireEvent.focus(handle);
    expect(handle).toHaveFocus();
    fireEvent.blur(handle);
    expect(handle).toBeInTheDocument();
  });

  it('suppresses hover reveal after a pointer drop until the row is re-entered', () => {
    const { container } = render(<Example handleVisibility="hover" />);
    const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    items.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 30,
        right: 100,
        bottom: index * 30 + 20,
        width: 100,
        height: 20,
      } as DOMRect);
    });
    const handle = within(items[0]).getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 55));
    fireEvent(window, pointer('pointerup', 10, 55));
    expect(items[0]).toHaveAttribute('data-drag-sort-hover-reveal-blocked', 'true');
    handle.focus();
    expect(handle).toHaveFocus();
    fireEvent.pointerEnter(items[0]);
    expect(items[0]).not.toHaveAttribute('data-drag-sort-hover-reveal-blocked');
  });

  it('uses an explicit portal overlay after pointer activation', () => {
    const { container } = render(<Example />);
    const host = document.querySelector('[data-drag-sort-overlay-host="true"]') as HTMLElement;
    expect(host).toBeInTheDocument();
    expect(host).toHaveAttribute('hidden');
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    } as DOMRect);
    const handle = screen.getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 30));
    expect(document.querySelector('[data-drag-sort-overlay="true"]')).toBeInTheDocument();
    expect(host).not.toHaveAttribute('hidden');
    fireEvent(window, pointer('pointercancel', 10, 30));
    expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();
  });

  it('keeps a full-row overlay mounted through activation, crossings, reversal, and lost capture', () => {
    const { container } = render(
      <DragSortScope reducedMotion={() => true} label="Panel layout">
        {['a', 'b', 'c'].map((id, index) => (
          <RepaintingOverlayItem key={id} id={id} index={index} />
        ))}
      </DragSortScope>
    );
    const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    items.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 30,
        right: 100,
        bottom: index * 30 + 20,
        width: 100,
        height: 20,
      } as DOMRect);
    });

    const host = document.querySelector('[data-drag-sort-overlay-host="true"]') as HTMLElement;
    const handle = within(items[0]).getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    expect(host).toHaveAttribute('hidden');

    // Cross the activation boundary and leave the source rect in separate
    // frames, as real pointer delivery does. The portal must become concrete
    // before the source placeholder is faded and remain so as projections
    // change in both directions.
    fireEvent(window, pointer('pointermove', 10, 15));
    fireEvent(window, pointer('pointermove', 10, 35));
    expect(host).not.toHaveAttribute('hidden');
    expect(host).toHaveAttribute('data-drag-sort-overlay', 'true');
    expect(host.style.getPropertyValue('--drag-sort-overlay-width')).toBe('100px');
    expect(host.style.getPropertyValue('--drag-sort-overlay-height')).toBe('20px');
    expect(host.style.getPropertyValue('--drag-sort-overlay-x')).toBe('0px');
    expect(host.style.getPropertyValue('--drag-sort-overlay-y')).toBe('25px');
    expect(items[0]).not.toHaveStyle({ visibility: 'hidden' });
    expect(items[0]).toHaveAttribute('data-drag-sort-placeholder', 'true');

    fireEvent(window, pointer('pointermove', 10, 75));
    expect(host).toHaveAttribute('data-drag-sort-phase', 'dragging');
    expect(host.style.getPropertyValue('--drag-sort-overlay-y')).toBe('65px');
    expect(items[0]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 60px, 0)' });
    expect(items[1]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, -30px, 0)' });
    expect(items[2]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, -30px, 0)' });
    const placeholder = document.querySelector(
      '[data-drag-sort-placeholder-gap="true"]'
    ) as HTMLElement;
    expect(placeholder).toBeInTheDocument();
    expect(placeholder).toHaveStyle({
      '--drag-sort-placeholder-width': '100px',
      '--drag-sort-placeholder-height': '20px',
      '--drag-sort-placeholder-x': '0px',
      '--drag-sort-placeholder-y': '60px',
    });

    fireEvent(window, pointer('pointermove', 10, 35));
    expect(host).toHaveAttribute('data-drag-sort-overlay', 'true');
    const originalPositionPlaceholder = document.querySelector(
      '[data-drag-sort-placeholder-gap="true"]'
    ) as HTMLElement;
    expect(originalPositionPlaceholder).toBeInTheDocument();
    expect(originalPositionPlaceholder).toHaveStyle({
      '--drag-sort-placeholder-y': '0px',
    });
    expect(items[1]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 0px, 0)' });

    fireEvent(items[0], pointer('lostpointercapture', 10, 35));
    expect(host).not.toHaveAttribute('data-drag-sort-overlay');
    expect(
      document.querySelector('[data-drag-sort-repainting-overlay="true"]')
    ).not.toBeInTheDocument();
  });

  it('keeps the source visible when no overlay content is supplied', () => {
    const { container } = render(
      <DragSortScope>
        <DragSortItem id="a" index={0} label="a">
          <span>a</span>
          <DragSortHandle />
        </DragSortItem>
        <DragSortItem id="b" index={1} label="b">
          <span>b</span>
          <DragSortHandle />
        </DragSortItem>
      </DragSortScope>
    );
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    } as DOMRect);
    const handle = within(item).getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 30));
    expect(item).not.toHaveStyle({ visibility: 'hidden' });
    expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();
    fireEvent(window, pointer('pointercancel', 10, 30));
  });

  it('exposes before and after target placement in axis-aware item state', () => {
    const { container } = render(<Example />);
    const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    items.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 30,
        right: 100,
        bottom: index * 30 + 20,
        width: 100,
        height: 20,
      } as DOMRect);
    });
    const handle = screen.getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 32));
    expect(items[1]).toHaveAttribute('data-drag-sort-placement', 'before');
    expect(items[1]).not.toHaveAttribute('data-drag-sort-target-indicator');
    fireEvent(window, pointer('pointermove', 10, 48));
    expect(items[1]).toHaveAttribute('data-drag-sort-placement', 'after');
    expect(items[1]).not.toHaveAttribute('data-drag-sort-target-indicator');
    fireEvent(window, pointer('pointercancel', 10, 48));
  });

  it('uses target-edge indicators throughout a projected move', () => {
    const { container } = render(<Example showTargetIndicator />);
    const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    items.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 30,
        right: 100,
        bottom: index * 30 + 20,
        width: 100,
        height: 20,
      } as DOMRect);
    });
    fireEvent(
      within(items[0]).getByRole('button', { name: 'Move a' }),
      pointer('pointerdown', 10, 10)
    );
    fireEvent(window, pointer('pointermove', 10, 32));
    expect(items[1]).toHaveAttribute('data-drag-sort-target-indicator', 'true');
    fireEvent(window, pointer('pointermove', 10, 48));
    expect(items[1]).toHaveAttribute('data-drag-sort-placement', 'after');
    expect(items[1]).toHaveAttribute('data-drag-sort-target-indicator', 'true');
    expect(
      document.querySelector('[data-drag-sort-placeholder-gap="true"]')
    ).not.toBeInTheDocument();
    fireEvent(window, pointer('pointercancel', 10, 32));
  });

  it('reveals an inside child slot only after the hold confirmation', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<InsideTargetExample />);
      const targets = [
        ...container.querySelectorAll<HTMLElement>('[data-drag-sort-target-element]'),
      ];
      targets.forEach((target, index) => {
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
          left: 0,
          top: index * 30,
          right: 100,
          bottom: index * 30 + 20,
          width: 100,
          height: 20,
        } as DOMRect);
      });

      fireEvent(targets[0], pointer('pointerdown', 10, 10));
      fireEvent(window, pointer('pointermove', 10, 40));
      expect(
        container.querySelector('[data-drag-sort-inside-slot="true"]')
      ).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(
        container.querySelector('[data-drag-sort-inside-slot="true"]')
      ).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(25);
      });
      expect(container.querySelector('[data-drag-sort-inside-slot="true"]')).toBeInTheDocument();
      fireEvent(window, pointer('pointercancel', 10, 40));
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates intermediate rows when a projection crosses them and resets them', () => {
    const { container } = render(
      <DragSortScope reducedMotion={() => true}>
        {['a', 'b', 'c'].map((id, index) => (
          <DragSortItem key={id} id={id} index={index} label={id}>
            <span>{id}</span>
            <DragSortHandle />
          </DragSortItem>
        ))}
      </DragSortScope>
    );
    const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    items.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 30,
        right: 100,
        bottom: index * 30 + 20,
        width: 100,
        height: 20,
      } as DOMRect);
    });

    const handle = within(items[0]).getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 75));
    expect(items[0]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 60px, 0)' });
    expect(items[1]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, -30px, 0)' });
    expect(items[2]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, -30px, 0)' });

    fireEvent(window, pointer('pointermove', 10, 30));
    expect(items[1]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 0px, 0)' });
    expect(items[2]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 0px, 0)' });
    fireEvent(window, pointer('pointercancel', 10, 30));
  });

  it('keeps an unrelated scope consumer out of pointer-update renders', () => {
    const onRender = vi.fn();
    const { container } = render(
      <DragSortScope reducedMotion={() => true}>
        <ScopeRenderProbe onRender={onRender} />
        {['a', 'b'].map((id, index) => (
          <DragSortItem key={id} id={id} index={index} label={id}>
            <DragSortHandle />
          </DragSortItem>
        ))}
      </DragSortScope>
    );
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    } as DOMRect);
    const initialRenders = onRender.mock.calls.length;
    const handle = within(item).getByRole('button', { name: 'Move a' });
    fireEvent(handle, pointer('pointerdown', 10, 10));
    fireEvent(window, pointer('pointermove', 10, 30));
    fireEvent(window, pointer('pointermove', 10, 45));
    expect(onRender).toHaveBeenCalledTimes(initialRenders);
    fireEvent(window, pointer('pointercancel', 10, 45));
  });

  it('dispatches one pointer candidate when a handle bubbles to its item', () => {
    let manager: ReturnType<typeof useDragSortContext>['manager'] | undefined;
    const { container } = render(
      <DragSortScope reducedMotion={() => true}>
        <ManagerCapture capture={(value) => (manager = value)} />
        <DragSortItem id="a" index={0} label="a">
          <DragSortHandle />
        </DragSortItem>
      </DragSortScope>
    );
    const item = container.querySelector('[data-drag-sort-id="a"]') as HTMLElement;
    const handle = within(item).getByRole('button', { name: 'Move a' });
    const pointerDown = vi.spyOn(manager!, 'pointerDown');
    fireEvent(handle, pointer('pointerdown', 10, 10));
    expect(pointerDown).toHaveBeenCalledTimes(1);
    fireEvent(window, pointer('pointercancel', 10, 10));
  });

  it('leaves one registration and no active operation under StrictMode', () => {
    render(
      <StrictMode>
        <Example />
      </StrictMode>
    );
    const handle = screen.getByRole('button', { name: 'Move b' });
    fireEvent.keyDown(handle, { key: ' ' });
    expect(screen.getByRole('status')).toHaveTextContent('b lifted');
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(screen.getByRole('status')).toHaveTextContent('b move cancelled');
  });
});
