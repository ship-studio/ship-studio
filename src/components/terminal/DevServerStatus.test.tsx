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

    // The last log line is echoed into the error hint too, so target the
    // log body by class rather than by text.
    const body = document.querySelector('.preview-status__logs-body');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('EADDRINUSE 3001');
    expect(body!.textContent).toContain('ready');
    expect(body!.textContent).not.toContain(esc);
    expect(body!.textContent).not.toContain('[32m');

    // Collapsing hides the body.
    fireEvent.click(screen.getByText(/Logs/));
    expect(document.querySelector('.preview-status__logs-body')).toBeNull();
  });

  it('echoes the last log line into the error hint', () => {
    renderStatus({ phase: 'error', devServerOutput: 'compiling…\nError: boom\n' });
    expect(screen.getByText(/last output: “Error: boom”/)).toBeInTheDocument();
  });

  it('says the server produced no output when the log is empty in the error state', () => {
    renderStatus({ phase: 'error', devServerOutput: '' });
    expect(screen.getByText(/produced no output/)).toBeInTheDocument();
  });

  it('does not render a logs section when there is no output', () => {
    renderStatus({ phase: 'loading', devServerOutput: '' });
    expect(screen.queryByText(/Logs/)).not.toBeInTheDocument();
  });

  describe('dead dev-server process (issue #161)', () => {
    it('swaps Retry for a real restart with a verbose explanation', () => {
      const onRestartServer = vi.fn();
      const props = renderStatus({
        phase: 'error',
        processExited: true,
        exitCode: 137,
        onRestartServer,
      });

      expect(screen.getByText('Dev server stopped')).toBeInTheDocument();
      // Verbose error: says the process died, includes the exit code, and
      // names the likely culprit so a non-developer isn't left guessing.
      expect(screen.getByText(/no longer running \(exit code 137\)/)).toBeInTheDocument();
      expect(screen.getByText(/AI agent/)).toBeInTheDocument();

      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Restart dev server'));
      expect(onRestartServer).toHaveBeenCalledOnce();
      expect(props.onRetry).not.toHaveBeenCalled();
    });

    it('omits the exit code from the message when unknown', () => {
      renderStatus({
        phase: 'error',
        processExited: true,
        exitCode: null,
        onRestartServer: vi.fn(),
      });
      expect(screen.getByText(/no longer running\. Something outside/)).toBeInTheDocument();
      expect(screen.queryByText(/exit code/)).not.toBeInTheDocument();
    });

    it('keeps Fix with agent available, demoted to secondary', () => {
      const props = renderStatus({
        phase: 'error',
        processExited: true,
        onRestartServer: vi.fn(),
      });
      fireEvent.click(screen.getByText('Fix with agent'));
      expect(props.onFixWithAgent).toHaveBeenCalledOnce();
    });

    it('falls back to Retry when no restart handler is wired', () => {
      const props = renderStatus({ phase: 'error', processExited: true });
      expect(screen.queryByText('Restart dev server')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Retry'));
      expect(props.onRetry).toHaveBeenCalledOnce();
    });

    it('never claims a static project process died (static has no PTY process)', () => {
      renderStatus({
        phase: 'error',
        isStaticProject: true,
        processExited: true,
        onRestartServer: vi.fn(),
      });
      expect(screen.getByText(/index\.html/)).toBeInTheDocument();
      expect(screen.queryByText(/no longer running/)).not.toBeInTheDocument();
    });
  });
});
