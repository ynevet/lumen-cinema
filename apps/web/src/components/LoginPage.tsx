import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';

type Mode = 'sign-in' | 'sign-up';

export function LoginPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('alice@example.com');
  const [password, setPassword] = useState('Password123!');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'sign-up';

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isSignUp) await signUp({ email, displayName, password });
      else await signIn(email, password);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Cannot reach the box office. Try again.',
      );
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(isSignUp ? 'sign-in' : 'sign-up');
    setError(null);
    if (!isSignUp) {
      setEmail('');
      setPassword('');
    }
  }

  return (
    <div className="gate">
      <div className="gate__inner">
        <div className="gate__card">
          <header className="gate__brand">
            <div className="gate__brand-mark marquee-word">
              Lumen <span>Cinema</span>
            </div>
            <p className="eyebrow gate__brand-sub">Box office · Hall 1</p>
          </header>

          <div className="stub stub--perforated">
            <form className="gate__form" onSubmit={handleSubmit} noValidate>
              {error ? (
                <p className="gate__error" role="alert">
                  {error}
                </p>
              ) : null}

              <label className="field">
                <span className="field__label">Email</span>
                <input
                  className="field__input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              {isSignUp ? (
                <label className="field">
                  <span className="field__label">Name on the booking</span>
                  <input
                    className="field__input"
                    type="text"
                    autoComplete="name"
                    required
                    minLength={2}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
              ) : null}

              <label className="field">
                <span className="field__label">Password</span>
                <input
                  className="field__input"
                  type="password"
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                  required
                  minLength={isSignUp ? 8 : 1}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              <button className="gate__submit" type="submit" disabled={busy}>
                {busy ? 'One moment…' : isSignUp ? 'Create account' : 'Sign in'}
              </button>

              <p className="gate__switch">
                {isSignUp ? 'Already have an account? ' : 'New here? '}
                <button type="button" onClick={switchMode}>
                  {isSignUp ? 'Sign in' : 'Create one'}
                </button>
              </p>

              {isSignUp ? null : (
                <div className="gate__demo">
                  Seeded accounts — open two browsers and race for a seat:
                  <br />
                  <strong>alice@example.com</strong> · <strong>bob@example.com</strong> ·{' '}
                  <strong>carol@example.com</strong>
                  <br />
                  Password <strong>Password123!</strong>
                </div>
              )}
            </form>
          </div>
        </div>
      </div>
      <footer className="gate__footer">
        <p className="eyebrow">Seats are held for 15 minutes</p>
      </footer>
    </div>
  );
}
