import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clientLog } from '../clientLog';

interface State {
  failed: boolean;
}

/**
 * Last line of defence: a rendering crash anywhere in the app (e.g. player state
 * with a bad number) shows a small reload panel instead of a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('rune crashed while rendering', error, info);
    clientLog('error', `render error: ${error.message}`, { componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <div className="empty" role="alert">
          <h3>Something went wrong</h3>
          <p>rune hit an unexpected error.</p>
          <button className="btn btn--primary" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
