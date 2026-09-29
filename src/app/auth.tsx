import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ApiError } from '../lib/errors';
import { clearStoredSession, HUMAN_STORAGE_KEY } from '../lib/storage';
import { recordRequest } from '../lib/telemetry';
import { useServices } from './services';

interface AuthValue {
  session: Session | null; loading: boolean; notice: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<string | null>;
  signOut: (notice?: string) => Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);

// Supabase Auth owns the session (persisted under its own storage key and
// refreshed by the library). Only public credentials exist in the browser.
export function AuthProvider({ children }: { children: ReactNode }) {
  const { client } = useServices();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client.auth.getSession().then(({ data }) => {
      if (active) { setSession(data.session); setLoading(false); }
    }).catch(() => { if (active) setLoading(false); });
    const { data } = client.auth.onAuthStateChange((_event, next) => { if (active) setSession(next); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!navigator.onLine) return 'Sin conexión. No se puede iniciar sesión sin conexión.';
    const started = performance.now();
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      recordRequest('auth.sign_in', !error ? null : error.status === 429 ? new ApiError('validation', 'RATE_LIMITED', 429)
        : error.status ? new ApiError('unauthenticated', 'UNAUTHENTICATED', error.status) : new ApiError('network', 'NETWORK'),
      false, performance.now() - started);
      if (!error) { setNotice(null); return null; }
      if (error.status === 429) return 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
      if (!error.status) return 'No hay conexión con el servicio. Inténtalo de nuevo.';
      return 'No se ha podido iniciar sesión. Comprueba el correo y la contraseña.';
    } catch {
      return 'No hay conexión con el servicio. Inténtalo de nuevo.';
    }
  }, [client]);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!navigator.onLine) return 'Sin conexión. No se puede crear la cuenta sin conexión.';
    const started = performance.now();
    try {
      const { data, error } = await client.auth.signUp({ email: email.trim(), password });
      recordRequest('auth.sign_in', !error ? null : error.status === 429 ? new ApiError('validation', 'RATE_LIMITED', 429)
        : error.status ? new ApiError('validation', 'INVALID_INPUT', error.status) : new ApiError('network', 'NETWORK'),
      false, performance.now() - started);
      if (!error) {
        setNotice(data.session
          ? 'Cuenta creada. Completa ahora el alta de tu empresa.'
          : 'Cuenta creada. Revisa tu correo y confirma la dirección antes de iniciar sesión.');
        return null;
      }
      if (error.status === 429) return 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
      if (!error.status) return 'No hay conexión con el servicio. Inténtalo de nuevo.';
      return 'No se ha podido crear la cuenta. Revisa los datos o inicia sesión si ya tienes una cuenta.';
    } catch {
      return 'No hay conexión con el servicio. Inténtalo de nuevo.';
    }
  }, [client]);

  // Local sign-out: other devices keep their sessions. If the server cannot be
  // reached, the stored session is still removed from this browser.
  const signOut = useCallback(async (message?: string) => {
    setNotice(message ?? null);
    const result = await client.auth.signOut({ scope: 'local' }).catch(() => ({ error: true }));
    if (result.error) clearStoredSession(HUMAN_STORAGE_KEY);
    setSession(null);
  }, [client]);

  const value = useMemo(() => ({ session, loading, notice, signIn, signUp, signOut }), [session, loading, notice, signIn, signUp, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth unavailable');
  return value;
}
