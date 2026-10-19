import React, { useEffect, useState } from 'react';
import {
  BrowserRouter,
  NavLink,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { api, setCSRF } from './api';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CoveragePage from './pages/CoveragePage';
import ConcatenatePage from './pages/ConcatenatePage';
import PerformancePage from './pages/PerformancePage';
export default function App() {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    api('/me')
      .then((u) => {
        setCSRF(u.csrf);
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  if (loading) return <main>Loading…</main>;
  if (!user) return <LoginPage onLogin={setUser} />;
  return (
    <BrowserRouter>
      <header>
        <div>
          <span className="brand-dot" />
          Global Patterns
        </div>
        <div className="row">
          <span>Signed in as {user.username}</span>
          <button
            onClick={async () => {
              try {
                await api('/logout', { method: 'POST' });
                setCSRF('');
                ['gp-import', 'gp-coverage', 'gp-performance'].forEach((k) =>
                  sessionStorage.removeItem(k),
                );
                setUser(null);
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav>
        {[
          ['/', 'Dashboard'],
          ['/coverage', 'Coverage Report'],
          ['/concatenate', 'Concatenate Sheet'],
          ['/performance', 'Keyword Performance Check'],
        ].map(([p, l]) => (
          <NavLink key={p} to={p} end={p === '/'}>
            {l}
          </NavLink>
        ))}
      </nav>
      <main>
        {error && <p className="error">{error}</p>}
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/coverage" element={<CoveragePage />} />
          <Route path="/concatenate" element={<ConcatenatePage />} />
          <Route path="/performance" element={<PerformancePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
