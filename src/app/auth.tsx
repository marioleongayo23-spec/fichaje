import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { clearStoredSession, HUMAN_STORAGE_KEY } from '../lib/storage';
import { useServices } from './services';

interface AuthValue {
  session: Session | null; loading: boolean; notice: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
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
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (!error) { setNotice(null); return null; }
      if (error.status === 429) return 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
      if (!error.status) return 'No hay conexión con el servicio. Inténtalo de nuevo.';
      return 'No se ha podido iniciar sesión. Comprueba el correo y la contraseña.';
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

  const value = useMemo(() => ({ session, loading, notice, signIn, signOut }), [session, loading, notice, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth unavailable');
  return value;
}
