import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useReveal } from '../src/lib/reveal';

function Probe({ id, text, streaming }: { id: string; text: string; streaming: boolean }) {
  return <Text testID="shown">{useReveal(id, text, streaming)}</Text>;
}

const shown = () => String(screen.getByTestId('shown').props.children);

/** Display frames, 16 ms apart. */
async function frames(n: number) {
  for (let i = 0; i < n; i++) await act(() => jest.advanceTimersByTime(16));
}

describe('useReveal', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reveals a streaming reply a frame at a time, never all at once', async () => {
    const view = await render(<Probe id="d1" text="" streaming />);
    await view.rerender(<Probe id="d1" text={'word '.repeat(40)} streaming />);
    await frames(1);
    const first = shown().length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(40);
    await frames(3);
    expect(shown().length).toBeGreaterThan(first);
  });

  it('carries on where the draft got to when the final message replaces it', async () => {
    const text = 'x'.repeat(400);
    const draft = await render(<Probe id="d2" text={text.slice(0, 300)} streaming />);
    await frames(4);
    const reached = shown().length;
    expect(reached).toBeLessThan(300);
    await draft.unmount();
    // The message row is a different component with the same id.
    await render(<Probe id="d2" text={text} streaming={false} />);
    expect(shown().length).toBe(reached);
    await frames(200);
    expect(shown()).toBe(text);
  });

  it('shows a message that never streamed in full at once', async () => {
    await render(<Probe id="old" text="Already here." streaming={false} />);
    expect(shown()).toBe('Already here.');
  });

  it('keeps what a changed text shares and reveals the rest', async () => {
    const view = await render(<Probe id="d3" text="" streaming />);
    await view.rerender(<Probe id="d3" text="Hello wrld, more" streaming />);
    await frames(60);
    expect(shown()).toBe('Hello wrld, more');
    await view.rerender(<Probe id="d3" text="Hello world, more" streaming />);
    expect(shown()).toBe('Hello w');
    await frames(60);
    expect(shown()).toBe('Hello world, more');
  });
});
