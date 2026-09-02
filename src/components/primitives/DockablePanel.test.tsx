import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockablePanel } from './DockablePanel';

const resizeObserverCallbacks: Array<() => void> = [];
const resizeObserverInstances: ResizeObserverMock[] = [];

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
    resizeObserverCallbacks.push(() => callback([], this as unknown as ResizeObserver));
  }

  observe = vi.fn();
  disconnect = vi.fn();
}

describe('DockablePanel', () => {
  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    resizeObserverInstances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 520,
      bottom: 680,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    });
    localStorage.clear();
  });

  it('tracks its dock container when surrounding panels resize', () => {
    let dockRect = {
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 520,
      bottom: 680,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => dockRect);

    const { container } = render(
      <div data-testid="dock-container">
        <DockablePanel
          docked
          ariaLabel="Moving panel"
          positionKey="movingPanelPosition"
          sizeKey="movingPanelSize"
          floatingSize={{ width: 360, height: 520 }}
          initialPosition={() => ({ left: 40, top: 60 })}
        >
          <div>Panel contents</div>
        </DockablePanel>
      </div>
    );

    const placeholder = container.querySelector('.dockable-panel__placeholder');
    const dockContainer = screen.getByTestId('dock-container');
    const observer = resizeObserverInstances[0];
    expect(observer.observe).toHaveBeenCalledWith(placeholder);
    expect(observer.observe).toHaveBeenCalledWith(dockContainer);

    dockRect = { ...dockRect, x: 220, left: 220, right: 620 };
    act(() => resizeObserverCallbacks[0]());

    expect(screen.getByLabelText('Moving panel')).toHaveStyle({
      left: '220px',
      top: '80px',
      width: '400px',
      height: '600px',
    });
  });

  it('remeasures when a dock slot moves without resizing', () => {
    let dockRect = {
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 520,
      bottom: 680,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => dockRect);

    const props = {
      docked: true,
      ariaLabel: 'Moving panel',
      positionKey: 'movingPanelPosition',
      sizeKey: 'movingPanelSize',
      floatingSize: { width: 360, height: 520 },
      initialPosition: () => ({ left: 40, top: 60 }),
    };
    const { rerender } = render(
      <DockablePanel {...props} placeholderClassName="dock-slot" dockLayoutKey="first-position">
        <div>Panel contents</div>
      </DockablePanel>
    );

    dockRect = { ...dockRect, x: 520, left: 520, right: 920 };
    rerender(
      <DockablePanel {...props} placeholderClassName="dock-slot" dockLayoutKey="second-position">
        <div>Panel contents</div>
      </DockablePanel>
    );

    expect(screen.getByLabelText('Moving panel')).toHaveStyle({
      left: '520px',
      top: '80px',
      width: '400px',
      height: '600px',
    });
  });

  it('can elevate a docked portal above a fullscreen owner', () => {
    render(
      <DockablePanel
        docked
        dockedZIndex="var(--z-floating-panel)"
        ariaLabel="Fullscreen dock"
        positionKey="fullscreenDockPosition"
        sizeKey="fullscreenDockSize"
        floatingSize={{ width: 360, height: 520 }}
        initialPosition={() => ({ left: 40, top: 60 })}
      >
        <div>Panel contents</div>
      </DockablePanel>
    );

    expect(screen.getByLabelText('Fullscreen dock')).toHaveStyle({
      zIndex: 'var(--z-floating-panel)',
    });
  });

  it('keeps its size when dragging a floating panel to the viewport edges', () => {
    render(
      <DockablePanel
        docked={false}
        ariaLabel="Moving panel"
        positionKey="movingPanelPosition"
        sizeKey="movingPanelSize"
        floatingSize={{ width: 360, height: 520 }}
        initialPosition={() => ({ left: 40, top: 60 })}
      >
        <div data-dockable-drag-handle>Panel header</div>
      </DockablePanel>
    );

    const surface = screen.getByLabelText('Moving panel');
    const header = screen.getByText('Panel header');
    fireEvent.pointerDown(header, { pointerId: 1, clientX: 50, clientY: 70 });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: window.innerWidth + 50,
      clientY: window.innerHeight + 50,
    });
    fireEvent.pointerUp(surface, {
      pointerId: 1,
      clientX: window.innerWidth + 50,
      clientY: window.innerHeight + 50,
    });

    expect(surface).toHaveStyle({ width: '400px', height: '600px' });
  });

  it('moves a fixed-size floating panel without adding resize handles', () => {
    render(
      <DockablePanel
        docked={false}
        ariaLabel="Color picker"
        positionKey="colorPickerPosition"
        sizeKey="colorPickerSize"
        floatingSize={{ width: 336, height: 571 }}
        initialPosition={() => ({ left: 40, top: 60 })}
        resizable={false}
      >
        <div data-dockable-drag-handle>Color picker title</div>
      </DockablePanel>
    );

    const surface = screen.getByLabelText('Color picker');
    const header = screen.getByText('Color picker title');
    fireEvent.pointerDown(header, { pointerId: 1, clientX: 50, clientY: 70 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 150, clientY: 170 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 170 });

    expect(surface).toHaveStyle({ width: '336px', height: '571px' });
    expect(
      screen.queryByRole('separator', { name: /Resize Color picker/ })
    ).not.toBeInTheDocument();
    expect(localStorage.getItem('colorPickerPosition')).toBe('{"left":220,"top":180}');
  });

  it('keeps nested portaled panel drag gestures independent', () => {
    render(
      <DockablePanel
        docked={false}
        ariaLabel="Variables panel"
        positionKey="variablesPosition"
        sizeKey="variablesSize"
        floatingSize={{ width: 360, height: 520 }}
        initialPosition={() => ({ left: 40, top: 60 })}
      >
        <div data-dockable-drag-handle>Variables title</div>
        <DockablePanel
          docked={false}
          ariaLabel="Color picker"
          positionKey="nestedColorPickerPosition"
          sizeKey="nestedColorPickerSize"
          floatingSize={{ width: 336, height: 571 }}
          initialPosition={() => ({ left: 300, top: 100 })}
          resizable={false}
        >
          <div data-dockable-drag-handle>Color picker title</div>
        </DockablePanel>
      </DockablePanel>
    );

    const variablesSurface = screen.getByLabelText('Variables panel');
    const colorSurface = screen.getByLabelText('Color picker');

    fireEvent.pointerDown(screen.getByText('Color picker title'), {
      pointerId: 1,
      clientX: 130,
      clientY: 90,
    });
    fireEvent.pointerMove(colorSurface, { pointerId: 1, clientX: 230, clientY: 190 });
    fireEvent.pointerUp(colorSurface, { pointerId: 1, clientX: 230, clientY: 190 });

    expect(localStorage.getItem('nestedColorPickerPosition')).toBe('{"left":220,"top":180}');
    expect(localStorage.getItem('variablesPosition')).toBeNull();

    fireEvent.pointerDown(screen.getByText('Variables title'), {
      pointerId: 2,
      clientX: 130,
      clientY: 90,
    });
    fireEvent.pointerMove(variablesSurface, { pointerId: 2, clientX: 180, clientY: 140 });
    fireEvent.pointerUp(variablesSurface, { pointerId: 2, clientX: 180, clientY: 140 });

    expect(localStorage.getItem('variablesPosition')).toBe('{"left":170,"top":130}');
    expect(localStorage.getItem('nestedColorPickerPosition')).toBe('{"left":220,"top":180}');
  });

  it('keeps its child mounted while moving between the dock and a floating surface', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const clicked = vi.fn();

    function StatefulChild() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return (
        <div data-dockable-drag-handle>
          Live terminal
          <button type="button" onClick={clicked}>
            Pin
          </button>
        </div>
      );
    }

    const props = {
      ariaLabel: 'Test panel',
      positionKey: 'testPanelPosition',
      sizeKey: 'testPanelSize',
      floatingSize: { width: 360, height: 520 },
      initialPosition: () => ({ left: 40, top: 60 }),
    };
    const { container, rerender, unmount } = render(
      <DockablePanel {...props} docked>
        <StatefulChild />
      </DockablePanel>
    );

    const surface = screen.getByLabelText('Test panel');
    const placeholder = container.querySelector('.dockable-panel__placeholder');
    expect(surface).toHaveClass('dockable-panel__surface--docked');
    expect(placeholder).toHaveClass('dockable-panel__placeholder--docked');
    expect(surface).toHaveStyle({
      left: '120px',
      top: '80px',
      width: '400px',
      height: '600px',
      zIndex: 'var(--z-dropdown)',
    });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Pin' }), { pointerId: 2 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Pin' }), { pointerId: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(clicked).toHaveBeenCalledTimes(1);

    rerender(
      <DockablePanel {...props} docked={false}>
        <StatefulChild />
      </DockablePanel>
    );

    expect(screen.getByLabelText('Test panel')).toBe(surface);
    expect(surface).toHaveClass('dockable-panel__surface--floating');
    expect(placeholder).toHaveClass('dockable-panel__placeholder--floating');
    expect(surface).toHaveStyle({
      width: '400px',
      height: '600px',
      zIndex: 'calc(var(--z-floating-panel) + 0)',
    });
    expect(localStorage.getItem('testPanelSize')).toBe('{"width":400,"height":600}');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Pin' }), { pointerId: 3 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Pin' }), { pointerId: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(clicked).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Test panel width' }), {
      key: 'ArrowRight',
    });
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Test panel height' }), {
      key: 'ArrowUp',
    });
    expect(surface).toHaveStyle({ width: '410px', height: '590px' });
    expect(localStorage.getItem('testPanelSize')).toBe('{"width":410,"height":590}');

    const heightHandle = screen.getByRole('separator', { name: 'Resize Test panel height' });
    fireEvent.pointerDown(heightHandle, { pointerId: 7, clientY: 650 });
    fireEvent.pointerMove(heightHandle, { pointerId: 7, clientY: 620 });
    fireEvent.pointerUp(heightHandle, { pointerId: 7, clientY: 620 });
    expect(surface).toHaveStyle({ height: '560px' });

    // A completed drag must not leave a move listener behind.
    fireEvent.pointerMove(heightHandle, { pointerId: 7, clientY: 500 });
    expect(surface).toHaveStyle({ height: '560px' });
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    const widthHandle = screen.getByRole('separator', { name: 'Resize Test panel width' });
    fireEvent.pointerDown(widthHandle, { pointerId: 8, clientX: 450 });
    fireEvent.pointerMove(widthHandle, { pointerId: 8, clientX: 500 });
    fireEvent.pointerUp(widthHandle, { pointerId: 8, clientX: 500 });
    expect(surface).toHaveStyle({ width: '460px' });

    fireEvent.pointerMove(widthHandle, { pointerId: 8, clientX: 600 });
    expect(surface).toHaveStyle({ width: '460px' });

    const cornerHandle = screen.getByRole('button', {
      name: 'Resize Test panel width and height',
    });
    fireEvent.pointerDown(cornerHandle, { pointerId: 9, clientX: 500, clientY: 620 });
    expect(document.body.style.cursor).toBe('nwse-resize');
    fireEvent.pointerMove(cornerHandle, { pointerId: 9, clientX: 540, clientY: 650 });
    fireEvent.pointerUp(cornerHandle, { pointerId: 9, clientX: 540, clientY: 650 });
    expect(surface).toHaveStyle({ width: '500px', height: '590px' });

    fireEvent.pointerMove(cornerHandle, { pointerId: 9, clientX: 700, clientY: 700 });
    expect(surface).toHaveStyle({ width: '500px', height: '590px' });
    expect(document.body.style.cursor).toBe('');

    fireEvent.pointerDown(screen.getByText('Live terminal'), {
      pointerId: 1,
      clientX: 130,
      clientY: 90,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 150, clientY: 170 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 170 });
    expect(localStorage.getItem('testPanelPosition')).toBe('{"left":140,"top":160}');

    rerender(
      <DockablePanel {...props} docked>
        <StatefulChild />
      </DockablePanel>
    );
    expect(screen.getByLabelText('Test panel')).toBe(surface);
    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(
      <DockablePanel {...props} docked={false} visible={false}>
        <StatefulChild />
      </DockablePanel>
    );
    expect(surface).toHaveClass('is-hidden');
    expect(surface).toHaveAttribute('aria-hidden', 'true');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    unmount();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it('supports every independent docked/floating combination', () => {
    const mounted = [vi.fn(), vi.fn(), vi.fn()];
    const labels = ['Agent', 'Elements', 'CSS'];

    function PanelChild({ index }: { index: number }) {
      useEffect(() => {
        mounted[index]();
      }, [index]);
      return <div>{labels[index]}</div>;
    }

    function Panels({ mask }: { mask: number }) {
      return labels.map((label, index) => (
        <DockablePanel
          key={label}
          docked={(mask & (1 << index)) !== 0}
          ariaLabel={`${label} panel`}
          positionKey={`${label}Position`}
          sizeKey={`${label}Size`}
          floatingSize={{ width: 300, height: 400 }}
          initialPosition={() => ({ left: 40 + index * 20, top: 60 + index * 20 })}
        >
          <PanelChild index={index} />
        </DockablePanel>
      ));
    }

    const { rerender } = render(<Panels mask={0} />);
    for (let mask = 0; mask < 8; mask += 1) {
      rerender(<Panels mask={mask} />);
      labels.forEach((label, index) => {
        expect(screen.getByLabelText(`${label} panel`)).toHaveClass(
          (mask & (1 << index)) !== 0
            ? 'dockable-panel__surface--docked'
            : 'dockable-panel__surface--floating'
        );
      });
    }

    mounted.forEach((onMount) => expect(onMount).toHaveBeenCalledTimes(1));
  });
});
