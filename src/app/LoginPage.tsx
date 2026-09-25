import { useEffect, useState, type FormEvent } from 'react';
import { BRAND } from '../config';
import { Field, LiveRegion, Notice } from '../ui/components';
import { useAuth } from './auth';

export function LoginPage() {
  const { signIn, notice } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [pending, setPending] = useState(false);
  useEffect(() => { document.title = `Iniciar sesión · ${BRAND}`; }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const errors = {
      email: /^[^\s@]+@[^\s@]+$/.test(email) ? undefined : 'Escribe un correo electrónico válido.',
      password: password ? undefined : 'Escribe tu contraseña.',
    };
    setFieldErrors(errors);
    if (errors.email || errors.password) { setError('Revisa los campos marcados.'); return; }
    setError(null);
    setPending(true);
    const message = await signIn(email, password);
    setPending(false);
    if (message) setError(message);
  };

  return (
    <main id="contenido" className="auth-page">
      <div className="auth-card">
        <p className="brand-mark" aria-hidden="true">{BRAND}</p>
        <h1>Iniciar sesión</h1>
        {notice && <Notice tone="info" title={notice} />}
        <form noValidate onSubmit={onSubmit}>
          <Field label="Correo electrónico" error={fieldErrors.email}>
            {(p) => <input {...p} name="email" type="email" autoComplete="username" inputMode="email" required />}
          </Field>
          <Field label="Contraseña" error={fieldErrors.password}>
            {(p) => <input {...p} name="password" type="password" autoComplete="current-password" required />}
          </Field>
          <LiveRegion tone="error" message={error} />
          <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
            {pending ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p className="hint">Tu empresa crea las cuentas; no hay registro público. Si no tienes correo, ficha en el kiosco de tu empresa.</p>
      </div>
    </main>
  );
}
