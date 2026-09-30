import { useEffect, useState, type FormEvent } from 'react';
import { BRAND } from '../config';
import { Field, LiveRegion, Notice } from '../ui/components';
import { useAuth } from './auth';

type Mode = 'login' | 'register';

export function LoginPage() {
  const { signIn, signUp, notice } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; repeat?: string }>({});
  const [pending, setPending] = useState(false);
  useEffect(() => { document.title = `${mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'} · ${BRAND}`; }, [mode]);

  const changeMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setFieldErrors({});
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // React clears currentTarget after dispatch; retain the form across Auth's await.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const repeat = String(form.get('repeat') ?? '');
    const errors = {
      email: /^[^\s@]+@[^\s@]+$/.test(email) ? undefined : 'Escribe un correo electrónico válido.',
      password: !password ? 'Escribe tu contraseña.'
        : mode === 'register' && password.length < 12 ? 'Usa al menos 12 caracteres.' : undefined,
      repeat: mode === 'register' && repeat !== password ? 'Las contraseñas no coinciden.' : undefined,
    };
    setFieldErrors(errors);
    if (errors.email || errors.password || errors.repeat) { setError('Revisa los campos marcados.'); return; }
    setError(null);
    setPending(true);
    const message = mode === 'login' ? await signIn(email, password) : await signUp(email, password);
    setPending(false);
    if (message) setError(message);
    else if (mode === 'register') {
      formElement.reset();
      setMode('login');
    }
  };

  return (
    <main id="contenido" className="auth-page">
      <div className="auth-card">
        <p className="brand-mark" aria-hidden="true">{BRAND}</p>
        <h1>{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h1>
        {notice && <Notice tone="info" title={notice} />}
        {mode === 'register' && (
          <p className="hint">Crea la cuenta de la persona responsable. Después de confirmar el correo podrás dar de alta tu empresa y quedarás como OWNER.</p>
        )}
        <form noValidate onSubmit={onSubmit}>
          <Field label="Correo electrónico" error={fieldErrors.email}>
            {(p) => <input {...p} name="email" type="email" autoComplete="username" inputMode="email" required />}
          </Field>
          <Field label="Contraseña" error={fieldErrors.password}
            hint={mode === 'register' ? 'Mínimo 12 caracteres.' : undefined}>
            {(p) => <input {...p} name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />}
          </Field>
          {mode === 'register' && (
            <Field label="Repite la contraseña" error={fieldErrors.repeat}>
              {(p) => <input {...p} name="repeat" type="password" autoComplete="new-password" required />}
            </Field>
          )}
          <LiveRegion tone="error" message={error} />
          <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
            {pending ? (mode === 'login' ? 'Entrando…' : 'Creando cuenta…') : (mode === 'login' ? 'Entrar' : 'Crear cuenta')}
          </button>
        </form>
        {mode === 'login' ? (
          <>
            <p className="hint">¿Tu empresa todavía no usa Fichaje APP?</p>
            <button type="button" className="btn btn-secondary btn-block" onClick={() => changeMode('register')}>Dar de alta una empresa</button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => changeMode('login')}>Ya tengo una cuenta</button>
        )}
        <p className="hint">Si trabajas para una empresa que ya usa Fichaje APP, entra con tu cuenta o acepta su invitación. Si no tienes correo, ficha en el kiosco de tu empresa.</p>
      </div>
    </main>
  );
}
