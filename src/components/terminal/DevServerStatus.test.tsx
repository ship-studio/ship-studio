import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DevServerStatus, type DevServerPhase } from './DevServerStatus';

function renderStatus(overrides: Partial<React.ComponentProps<typeof DevServerStatus>> = {}) {
  const props = {
    phase: 'loading' as DevServerPhase,
    isStaticProject: false,
    port: 3001,
    retryCount: 24,
    maxRetries: 60,
    devServerOutput: '',
    onStop: vi.fn(),
    onRetry: vi.fn(),
    onFixWithAgent: vi.fn(),
    ...overrides,
  };
  render(<DevServerStatus {...props} />);
  return props;
}

describe('DevServerStatus', () => {
  it('shows Stop + the attempt counter once past warm-up', () => {
    const props = renderStatus({ phase: 'loading', retryCount: 24 });
    expect(screen.getByText('Still trying… (attempt 24 of 60)')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Stop'));
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('shows a calm warm-up message early, before the raw attempt counter', () => {
    renderStatus({ phase: 'loading', retryCount: 5 });
    expect(screen.getByText('This can take a minute the first time…')).toBeInTheDocument();
    expect(screen.queryByText(/attempt 5 of 60/)).not.toBeInTheDocument();
  });

  it('swaps Stop for Retry once stopped, without showing an attempt counter', () => {
    const props = renderStatus({ phase: 'stopped' });
    expect(screen.queryByText(/Attempt/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('offers Retry in the error state', () => {
    const props = renderStatus({ phase: 'error' });
    fireEvent.click(screen.getByText('Retry'));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('hands off to the agent when asked', () => {
    const props = renderStatus({ phase: 'loading' });
    fireEvent.click(screen.getByText('Fix with agent'));
    expect(props.onFixWithAgent).toHaveBeenCalledOnce();
  });

  it('omits the agent button when no handler is wired', () => {
    renderStatus({ phase: 'error', onFixWithAgent: undefined });
    expect(screen.queryByText('Fix with agent')).not.toBeInTheDocument();
  });

  it('renders the tail of the dev-server logs (ANSI stripped) and toggles them', () => {
    // Build real ANSI color codes around "ready" without putting invisible bytes
    // in the source. They must not leak into the rendered DOM.
    const esc = String.fromCharCode(27);
    const output = `${esc}[32mready${esc}[0m\nError: listen EADDRINUSE 3001`;
    renderStatus({ phase: 'error', devServerOutput: output });

    const body = screen.getByText(/EADDRINUSE 3001/);
    expect(body).toBeInTheDocument();
    expect(body.textContent).toContain('ready');
    expect(body.textContent).not.toContain(esc);
    expect(body.textContent).not.toContain('[32m');

    // Collapsing hides the body.
    fireEvent.click(screen.getByText(/Logs/));
    expect(screen.queryByText(/EADDRINUSE 3001/)).not.toBeInTheDocument();
  });

  it('does not render a logs section when there is no output', () => {
    renderStatus({ phase: 'loading', devServerOutput: '' });
    expect(screen.queryByText(/Logs/)).not.toBeInTheDocument();
  });
});
