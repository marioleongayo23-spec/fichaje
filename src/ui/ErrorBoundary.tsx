import { Component, type ReactNode } from 'react';

// Last-resort screen: never shows stack traces, data or identifiers.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main id="contenido" className="auth-page">
        <div className="auth-card" role="alert">
          <h1>Se ha producido un error</h1>
          <p>Recarga la página para consultar tu estado real en el servidor. Si se repite, avisa a tu empresa.</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Recargar</button>
        </div>
      </main>
    );
  }
}
