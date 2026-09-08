import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { isTauriRuntime } from '../lib/webEvents';
import { Button } from './primitives/Button';
import { Spinner } from './primitives/Spinner';

export function WebAuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(isTauriRuntime());
  const [checking, setChecking] = useState(!isTauriRuntime());
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isTauriRuntime()) return;
    void fetch('/api/session', { credentials: 'same-origin' })
      .then((response) => setAuthenticated(response.ok))
      .catch(() => setAuthenticated(false))
      .finally(() => setChecking(false));
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    if (!response?.ok) {
      setError('Invalid token');
      return;
    }
    setAuthenticated(true);
  };

  if (authenticated) return children;
  if (checking) {
    return (
      <main className="web-auth-screen">
        <Spinner size="lg" />
      </main>
    );
  }
  return (
    <main className="web-auth-screen">
      <form className="web-auth-card" onSubmit={(event) => void login(event)}>
        <h1>Ship Studio</h1>
        <p>Enter the server token to continue.</p>
        <label htmlFor="ship-auth-token">Auth token</label>
        <input
          id="ship-auth-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="current-password"
          autoFocus
          required
        />
        {error && <p className="web-auth-error">{error}</p>}
        <Button variant="primary" type="submit">
          Sign in
        </Button>
      </form>
    </main>
  );
}
