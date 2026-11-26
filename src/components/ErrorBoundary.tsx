import { Component, ReactNode } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from '../lib/logger';
import { reportRenderCrash } from '../lib/renderCrash';
import { Button } from './primitives/Button';
import { InfoIcon } from '@/components/icons';
import { asCommandError, formatCommandError } from '../lib/errors';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Reports to the admin agent and auto-removes a crashing plugin. Most
    // surfaces have a PanelErrorBoundary of their own, so reaching this one
    // means the crash was outside every panel.
    reportRenderCrash(error, errorInfo);
  }

  /** Check if the error likely originated from a plugin */
  private isPluginError(): boolean {
    const msg = this.state.error?.message ?? '';
    const stack = this.state.error?.stack ?? '';
    return (
      msg.includes('Plugin context') ||
      msg.includes('plugin-sdk') ||
      stack.includes('blob:') ||
      stack.includes('usePluginContext')
    );
  }

  handleContinue = () => {
    this.setState({ hasError: false, error: null });
  };

  handleRestart = async () => {
    try {
      await relaunch();
    } catch (err) {
      // In dev mode, relaunch might not work - try window reload
      logger.error('Relaunch failed, trying reload', {
        error: formatCommandError(asCommandError(err)),
      });
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary__icon">
            <InfoIcon size={48} />
          </div>
          <h1 className="error-boundary__title">Something went wrong</h1>
          <p className="error-boundary__message">
            {this.isPluginError()
              ? 'A plugin crashed. You can continue without it or restart the app.'
              : this.state.error?.message || 'An unexpected error occurred'}
          </p>
          {!this.isPluginError() && (
            <p className="error-boundary__report-status">
              Check Settings &amp; Help → Report Bug for confirmed automatic reports, or report this
              problem yourself.
            </p>
          )}
          <div className="error-boundary__actions">
            {this.isPluginError() && (
              <Button variant="primary" onClick={this.handleContinue}>
                Continue
              </Button>
            )}
            <Button
              variant={this.isPluginError() ? 'secondary' : 'primary'}
              onClick={() => void this.handleRestart()}
            >
              Restart App
            </Button>
          </div>
          {this.state.error && (
            <details className="error-boundary__details">
              <summary className="error-boundary__summary">Technical details</summary>
              <pre className="error-boundary__stack">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
