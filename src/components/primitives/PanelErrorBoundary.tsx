import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportRenderCrash } from '../../lib/renderCrash';
import { Button } from './Button';
import { InfoIcon } from '@/components/icons';

interface Props {
  children: ReactNode;
  /**
   * Which surface this is, for the crash report: a stable id such as
   * `variables` or `modal:Settings`. Never shown to the user.
   */
  panel: string;
  /** What the user calls this surface, e.g. "Variables panel". */
  label?: string;
  /**
   * Offered beside Retry when the crashed content was also what held the
   * surface's own close control (a modal body, a floating tool).
   */
  onDismiss?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Contains a render crash to one surface. The rest of the app keeps working,
 * the user gets a local "this crashed, retry" in place of the surface, and the
 * crash is reported exactly as the top-level `ErrorBoundary` would report it,
 * tagged with `panel`.
 *
 * Built into `DockablePanel` and `ModalFrame`, so every rail panel, floating
 * tool and modal already has one. Wrap other independently-failing surfaces
 * directly. Before this, one bad element in one list (#1211) replaced the
 * entire window.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportRenderCrash(error, errorInfo, { panel: this.props.panel });
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label, onDismiss } = this.props;

    return (
      <div className="panel-error-boundary" role="alert">
        <span className="panel-error-boundary__icon">
          <InfoIcon size={20} />
        </span>
        <p className="panel-error-boundary__title">
          {label ? `${label} crashed` : 'This panel crashed'}
        </p>
        <p className="panel-error-boundary__message">
          The rest of Ship Studio is still working. Retry to reload just this part.
        </p>
        <div className="panel-error-boundary__actions">
          <Button size="compact" variant="primary" onClick={this.retry}>
            Retry
          </Button>
          {onDismiss && (
            <Button size="compact" variant="secondary" onClick={onDismiss}>
              Close
            </Button>
          )}
        </div>
        <details className="panel-error-boundary__details">
          <summary>Technical details</summary>
          <pre className="panel-error-boundary__stack">{error.stack || error.message}</pre>
        </details>
      </div>
    );
  }
}
