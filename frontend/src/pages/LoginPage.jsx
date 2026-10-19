import React, { useState } from 'react';
import { api, setCSRF } from '../api';
export default function LoginPage({ onLogin }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const f = new FormData(e.target),
        u = await api('/login', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(f)),
        });
      setCSRF(u.csrf);
      onLogin(u);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login card">
      <div className="eyebrow">GLOBAL PATTERNS</div>
      <h1>Welcome back</h1>
      <p>Sign in to manage patterns and review performance.</p>
      <form onSubmit={submit}>
        <label>
          Username
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
