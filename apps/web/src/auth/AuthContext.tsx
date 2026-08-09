import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PublicUser } from '@lumen/shared';
import { api, onUnauthorized, tokenStore } from '../api/client';

interface AuthState {
  user: PublicUser | null;
  status: 'checking' | 'signed-in' | 'signed-out';
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; displayName: string; password: string }) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('checking');

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setStatus('signed-out');
  }, []);

  // A stored token may have expired while the tab was closed - verify before trusting it.
  useEffect(() => {
    let cancelled = false;
    const token = tokenStore.get();
    if (!token) {
      setStatus('signed-out');
      return;
    }
    api
      .me()
      .then(({ user: me }) => {
        if (cancelled) return;
        setUser(me);
        setStatus('signed-in');
      })
      .catch(() => {
        if (!cancelled) signOut();
      });
    return () => {
      cancelled = true;
    };
  }, [signOut]);

  // Any 401 from anywhere in the app drops us back to the login screen.
  useEffect(() => {
    const handler = () => signOut();
    onUnauthorized.addEventListener('unauthorized', handler);
    return () => onUnauthorized.removeEventListener('unauthorized', handler);
  }, [signOut]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    tokenStore.set(result.token);
    setUser(result.user);
    setStatus('signed-in');
  }, []);

  const signUp = useCallback(async (input: { email: string; displayName: string; password: string }) => {
    const result = await api.register(input);
    tokenStore.set(result.token);
    setUser(result.user);
    setStatus('signed-in');
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, status, signIn, signUp, signOut }),
    [user, status, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
