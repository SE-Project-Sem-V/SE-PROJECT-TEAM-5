import { useEffect, useRef, useState } from 'react';
import { login, register } from '../api.js';

export default function AuthScreen({ onAuth, notice }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState(null); // 'username' | 'displayName' | 'password' | null
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef(null);
  const displayNameRef = useRef(null);
  const passwordRef = useRef(null);
  const isRegister = mode === 'register';

  // Put the cursor in the username box on load and whenever the user switches between log in and register.
  useEffect(() => {
    usernameRef.current?.focus();
  }, [mode]);

  function fail(message, field = null) {
    setError(message);
    setErrorField(field);
    if (field === 'username') usernameRef.current?.focus();
    if (field === 'displayName') displayNameRef.current?.focus();
    if (field === 'password') passwordRef.current?.focus();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setErrorField(null);
    if (!username.trim()) return fail('Enter a username.', 'username');
    if (isRegister && (username.trim().length < 3 || username.trim().length > 64)) {
      return fail('Username must be 3 to 64 characters.', 'username');
    }
    if (isRegister && !displayName.trim()) return fail('Enter a display name.', 'displayName');
    if (isRegister && displayName.trim().length > 100) {
      return fail('Display name must be at most 100 characters.', 'displayName');
    }
    if (!password) return fail('Enter a password.', 'password');
    setBusy(true);
    try {
      onAuth(
        isRegister
          ? await register(username.trim(), password, displayName.trim())
          : await login(username.trim(), password),
      );
    } catch (err) {
      fail(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  return (
    <div className="auth">
      <section className="auth-brand">
        <div>
          <h2>Team 5 Chat</h2>
          <p>Message your teammates in real time.</p>
        </div>
        <ul className="auth-points">
          <li>See who is online</li>
          <li>Know when your message has reached the server</li>
          <li>Reconnects by itself when your network drops</li>
        </ul>
        <div className="bubbles" aria-hidden="true">
          <div className="bubble in">Did the build pass?</div>
          <div className="bubble out">Green ticks all round.</div>
        </div>
      </section>

      <main className="auth-panel">
        <form className="auth-card" onSubmit={handleSubmit} noValidate>
          <h1>{isRegister ? 'Create your account' : 'Log in'}</h1>
          <p className="sub">
            {isRegister
              ? 'Choose a username, a display name and a password to start chatting.'
              : 'Welcome back. Enter your details.'}
          </p>

          {notice && <p className="note" role="status" data-testid="logout-status">{notice}</p>}

          {error && (
            <p id="auth-error" className="error" role="alert" data-testid="auth-error">
              {error}
            </p>
          )}

          <div className="field">
            <label htmlFor="auth-username">Username</label>
            <input
              id="auth-username"
              ref={usernameRef}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={64}
              autoComplete="username"
              aria-invalid={errorField === 'username'}
              aria-describedby={errorField === 'username' ? 'auth-error' : undefined}
              data-testid="auth-username"
            />
          </div>

          {isRegister && (
            <div className="field">
              <label htmlFor="auth-displayname">Display name</label>
              <input
                id="auth-displayname"
                ref={displayNameRef}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={100}
                autoComplete="name"
                aria-invalid={errorField === 'displayName'}
                aria-describedby={errorField === 'displayName' ? 'auth-error' : undefined}
                data-testid="auth-displayname"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <div className="pw">
              <input
                id="auth-password"
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                aria-invalid={errorField === 'password'}
                aria-describedby={errorField === 'password' ? 'auth-error' : undefined}
                data-testid="auth-password"
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                data-testid="auth-show-password"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

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
                setErrorField(null);
              }}
            >
              {isRegister ? 'Log in' : 'Create an account'}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
