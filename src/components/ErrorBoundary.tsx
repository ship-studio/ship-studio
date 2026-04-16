import { Component, ReactNode } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from '../lib/logger';

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

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.logError(error, { componentStack: errorInfo.componentStack ?? undefined });
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
        error: err instanceof Error ? err.message : String(err),
      });
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            backgroundColor: '#1e1e1e',
            color: '#cccccc',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            padding: '20px',
            textAlign: 'center',
          }}
        >
          <div style={{ marginBottom: '24px' }}>
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f14c4c"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 8px 0' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '14px', color: '#888', margin: '0 0 24px 0', maxWidth: '400px' }}>
            {this.isPluginError()
              ? 'A plugin crashed. You can continue without it or restart the app.'
              : this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            {this.isPluginError() && (
              <button
                onClick={this.handleContinue}
                style={{
                  backgroundColor: '#2472c8',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background-color 150ms',
                }}
                onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#1e5fa8')}
                onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#2472c8')}
              >
                Continue
              </button>
            )}
            <button
              onClick={() => void this.handleRestart()}
              style={{
                backgroundColor: this.isPluginError() ? '#3a3a3a' : '#2472c8',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'background-color 150ms',
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.backgroundColor = this.isPluginError()
                  ? '#4a4a4a'
                  : '#1e5fa8')
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.backgroundColor = this.isPluginError()
                  ? '#3a3a3a'
                  : '#2472c8')
              }
            >
              Restart App
            </button>
          </div>
          {this.state.error && (
            <details
              style={{
                marginTop: '24px',
                fontSize: '12px',
                color: '#666',
                maxWidth: '500px',
                textAlign: 'left',
              }}
            >
              <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>
                Technical details
              </summary>
              <pre
                style={{
                  backgroundColor: '#2a2a2a',
                  padding: '12px',
                  borderRadius: '4px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
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
