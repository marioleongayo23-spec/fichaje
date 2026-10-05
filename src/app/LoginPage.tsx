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
    <main id="contenido" className="auth-page bundy-auth-page">
      <div className="bundy-auth-shell">
        <section className="auth-card bundy-auth-card" aria-labelledby="auth-title">
          <div className="bundy-wordmark-image" role="img" aria-label="bundy" />
          <div className="bundy-auth-heading">
            <h1 id="auth-title">{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h1>
            <p className="bundy-auth-display">{mode === 'login' ? 'Hola de nuevo' : 'Crea tu cuenta'}</p>
            <p className="bundy-auth-lead">
              {mode === 'login'
                ? 'Entra para ver tu equipo y tus horas.'
                : 'Crea tu acceso. Después podrás dar de alta tu empresa o aceptar una invitación.'}
            </p>
          </div>

          {notice && <Notice tone="info" title={notice} />}
          {mode === 'register' && (
            <p className="hint bundy-auth-note">Crear una cuenta no te da acceso a ninguna empresa ni te asigna un rol. Confirma tu correo e inicia sesión; después podrás crear tu primera empresa como OWNER o aceptar la invitación de tu empresa.</p>
          )}

          <form noValidate onSubmit={onSubmit} className="bundy-auth-form">
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
            <button type="submit" className="btn btn-primary btn-block bundy-auth-submit" disabled={pending}>
              {pending ? (mode === 'login' ? 'Entrando…' : 'Creando cuenta…') : (mode === 'login' ? 'Entrar' : 'Crear cuenta')}
            </button>
          </form>

          {mode === 'login' ? (
            <div className="bundy-auth-secondary">
              <p className="bundy-auth-question">¿Todavía no usas Bundy?</p>
              <button type="button" className="btn btn-secondary btn-block" onClick={() => changeMode('register')}>Dar de alta una empresa</button>
              <p className="hint">¿Tu empresa te ha enviado una invitación y todavía no tienes cuenta?</p>
              <button type="button" className="btn btn-link btn-block" onClick={() => changeMode('register')}>Crear cuenta para aceptar una invitación</button>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => changeMode('login')}>Ya tengo una cuenta</button>
          )}

          <p className="hint bundy-auth-footnote">Si ya trabajas en una empresa que usa Bundy, entra con tu cuenta o acepta su invitación. Si no tienes correo, ficha en el kiosco de tu empresa.</p>
        </section>

        <aside className="bundy-auth-story" aria-hidden="true">
          <div className="bundy-story-symbol"><img src="/bundy-app-icon.svg" alt="" /></div>
          <p className="bundy-story-kicker">Fichamos desde 1888</p>
          <p className="bundy-story-title">Horas claras,<br />equipos tranquilos.</p>
          <div className="bundy-story-phone">
            <div className="bundy-story-status"><span>08:57</span><span>●●● 5G</span></div>
            <div className="bundy-story-greeting">Buenos días,<strong>Lucía</strong></div>
            <div className="bundy-story-card">Tu jornada, siempre a la vista.</div>
            <div className="bundy-story-button"><img src="/bundy-symbol.svg" alt="" />Hacer bundy<small>Entrada</small></div>
          </div>
        </aside>
      </div>
    </main>
  );
}
