import { useState } from 'react';
import { login, register } from '../api.js';

export default function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    if (!username.trim()) return setError('Enter a username.');
    if (!password) return setError('Enter a password.');
    setBusy(true);
    try {
      const submit = isRegister ? register : login;
      onAuth(await submit(username.trim(), password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={handleSubmit} noValidate>
        <h1>{isRegister ? 'Create your account' : 'Log in'}</h1>
        <p className="sub">
          {isRegister ? 'Pick a username to start chatting.' : 'Welcome back. Enter your details.'}
        </p>
        {error && (
          <p className="error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            data-testid="auth-username"
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            data-testid="auth-password"
          />
        </label>
        <button className="btn" type="submit" disabled={busy} data-testid="auth-submit">
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>
        <p className="switch">
          {isRegister ? 'Already registered? ' : 'New here? '}
          <button
            type="button"
            className="link"
            data-testid="auth-toggle"
            onClick={() => {
              setMode(isRegister ? 'login' : 'register');
              setError('');
            }}
          >
            {isRegister ? 'Log in' : 'Create an account'}
          </button>
        </p>
      </form>
    </div>
  );
}
