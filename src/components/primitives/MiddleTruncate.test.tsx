import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MiddleTruncate } from './MiddleTruncate';

const resizeObserverCallbacks: Array<() => void> = [];
const resizeObserverInstances: ResizeObserverMock[] = [];
let availableWidth = 120;
let nextFrameId = 0;
const animationFrames = new Map<number, FrameRequestCallback>();

function graphemeCount(value: string): number {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'grapheme' }
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Segmenter) return Array.from(value).length;
  return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)).length;
}

function rect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 20,
    width,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;
}

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
    resizeObserverCallbacks.push(() => callback([], this as unknown as ResizeObserver));
  }

  observe = vi.fn();
  disconnect = vi.fn();
}

function flushAnimationFrames() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  callbacks.forEach((callback) => callback(0));
}

describe('MiddleTruncate', () => {
  beforeEach(() => {
    availableWidth = 120;
    resizeObserverCallbacks.length = 0;
    resizeObserverInstances.length = 0;
    animationFrames.clear();
    nextFrameId = 0;

    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      animationFrames.delete(id);
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      direction: 'ltr',
      measureText: (value: string) => ({ width: graphemeCount(value) * 10 }),
    } as unknown as CanvasRenderingContext2D);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('middle-truncate')) return rect(availableWidth);
      if (this.classList.contains('middle-truncate__measure')) {
        return rect(graphemeCount(this.textContent ?? '') * 10);
      }
      return rect(0);
    });
  });

  it('leaves short and exact-fit strings unchanged', () => {
    const { rerender } = render(<MiddleTruncate text="Ship Studio" data-testid="path" />);
    const path = screen.getByTestId('path');

    expect(path).toHaveTextContent('Ship Studio');
    expect(path).not.toHaveAttribute('aria-label');

    availableWidth = graphemeCount('exact fit') * 10;
    rerender(<MiddleTruncate text="exact fit" data-testid="path" />);
    expect(path).toHaveTextContent('exact fit');
    expect(path).not.toHaveAttribute('aria-label');
  });

  it('balances the start and end of a long string and exposes the full value', () => {
    const text = '/Users/martin/ShipStudio/projects/website/src/App.tsx';
    render(<MiddleTruncate text={text} data-testid="path" title="Project path" />);

    const path = screen.getByTestId('path');
    const visibleText = path.textContent ?? '';

    expect(visibleText).toContain('…');
    expect(visibleText.startsWith('/')).toBe(true);
    expect(visibleText.endsWith('x')).toBe(true);
    expect(visibleText.length).toBeLessThan(text.length);
    expect(path).toHaveAttribute('aria-label', text);
    expect(path).toHaveAttribute('title', 'Project path');
  });

  it('recalculates when its observed width grows', () => {
    const text = '/Users/martin/ShipStudio/projects/website/src/App.tsx';
    const { unmount } = render(<MiddleTruncate text={text} data-testid="path" />);
    const path = screen.getByTestId('path');
    const observer = resizeObserverInstances[0];

    expect(path.textContent).toContain('…');

    availableWidth = 1000;
    act(() => {
      resizeObserverCallbacks[0]();
      flushAnimationFrames();
    });

    expect(path).toHaveTextContent(text);
    expect(path).not.toHaveAttribute('aria-label');

    unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles zero-width containers without throwing or overflowing text', () => {
    availableWidth = 0;
    render(<MiddleTruncate text="/Users/martin/ShipStudio" data-testid="path" />);

    const path = screen.getByTestId('path');
    expect(path).toHaveTextContent('…');
    expect(path.textContent?.length).toBe(1);
  });

  it.each(['emoji-👨‍👩‍👧‍👦-end', 'accent-é-end', '中文项目-结尾', 'ภาษาไทย-ท้าย', 'مسار-النهاية'])(
    'keeps %s truncation boundaries on text graphemes',
    (text) => {
      availableWidth = 50;
      render(<MiddleTruncate text={text} data-testid="path" />);

      const visibleText = screen.getByTestId('path').textContent ?? '';
      expect(visibleText).toContain('…');
      expect(visibleText).not.toMatch(/\u200d(?!👩|👧|👦)/u);
      expect(visibleText).not.toMatch(/(?<!e)́/u);
    }
  );

  it('responds to text and styling changes', () => {
    const firstText = '/Users/martin/ShipStudio/projects/first/App.tsx';
    const secondText = '/Users/martin/ShipStudio/projects/second/index.ts';
    const { rerender } = render(
      <MiddleTruncate text={firstText} data-testid="path" style={{ fontSize: '12px' }} />
    );

    rerender(<MiddleTruncate text={secondText} data-testid="path" style={{ fontSize: '14px' }} />);
    expect(screen.getByTestId('path')).toHaveAttribute('aria-label', secondText);
    expect(resizeObserverInstances[0].observe).toHaveBeenCalled();
  });
});
