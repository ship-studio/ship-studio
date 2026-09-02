import { Component, ReactNode } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from '../lib/logger';
import { getAnalyticsEnabled } from '../lib/analytics';
import { lookupBlobOwner, markPluginCrashed } from '../lib/plugin-loader';
import { uninstallPlugin } from '../lib/plugins';
import { Button } from './primitives/Button';
import { InfoIcon } from '@/components/icons';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** True when the crash was actually reported (production build, user has
   *  analytics & error reports enabled, not a plugin crash). */
  reportedAutomatically: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, reportedAutomatically: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.logError(error, { componentStack: errorInfo.componentStack ?? undefined });

    // The logError above also reports the crash to the admin agent
    // (logger forwards error-level logs — see docs/error-reporting.md).

    // Auto-remove crashing plugins so they don't crash again on Continue
    const stack = error.stack ?? '';
    const blobMatch = /blob:[^\s:)]+/.exec(stack);

    // Show the "reported automatically" disclosure only when a report really
    // went out: production build, analytics & error reports enabled, and not
    // a plugin crash (those are excluded from reporting).
    if (import.meta.env.PROD && !blobMatch) {
      getAnalyticsEnabled()
        .then((enabled) => {
          if (enabled) this.setState({ reportedAutomatically: true });
        })
        .catch(() => {});
    }

    if (blobMatch) {
      const owner = lookupBlobOwner(blobMatch[0]);
      if (owner) {
        markPluginCrashed(owner.pluginId);
        void uninstallPlugin(owner.projectPath, owner.pluginId).catch((e) =>
          console.error(`Failed to auto-remove plugin "${owner.pluginId}":`, e)
        );
      }
    }
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
    this.setState({ hasError: false, error: null, reportedAutomatically: false });
  };

  handleRestart = async () => {
    try {
      await relaunch();
    } catch (err) {
      // In dev mode, relaunch might not work - try window reload
      logger.error('Relaunch failed, trying reload', {
        error: err instanceof Error ? err.message : String(err),
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
          {this.state.reportedAutomatically && (
            <p className="error-boundary__report-status">
              This crash was reported automatically so it can be fixed.
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
