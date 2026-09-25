import { useEffect, useId, useRef, type ReactNode } from 'react';
import { BRAND } from '../config';
import { formatDuration, spokenDuration } from '../lib/time';

// Accessible building blocks. Status never relies on colour alone: every tone
// carries a visible word, and dynamic messages live in polite/assertive regions.
type Tone = 'info' | 'success' | 'warning' | 'error';
const TONE_PREFIX: Record<Tone, string> = { info: 'Información', success: 'Hecho', warning: 'Atención', error: 'Error' };

export function Notice({ tone, title, children }: { tone: Tone; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`}>
      <p className="notice-title"><span className="notice-tag">{TONE_PREFIX[tone]}:</span> {title}</p>
      {children && <div className="notice-body">{children}</div>}
    </div>
  );
}

// The region exists before content changes so screen readers announce updates.
export function LiveRegion({ tone, message, children }: { tone: Tone; message?: string | null; children?: ReactNode }) {
  const urgent = tone === 'error';
  return (
    <div role={urgent ? 'alert' : 'status'} aria-live={urgent ? 'assertive' : 'polite'} className="live-region">
      {message ? <Notice tone={tone} title={message}>{children}</Notice> : null}
    </div>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return <p role="status" className="loading">{label}</p>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  useEffect(() => { document.title = `${title} · ${BRAND}`; }, [title]);
  return (
    <header className="page-header">
      <h1 tabIndex={-1} id="page-title">{title}</h1>
      {children && <div className="page-intro">{children}</div>}
    </header>
  );
}

export function Field({ label, hint, error, children }: {
  label: string; hint?: string; error?: string | null; children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint && <p className="hint" id={hintId}>{hint}</p>}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && <p className="field-error" id={errorId}><span className="notice-tag">Error:</span> {error}</p>}
    </div>
  );
}

export function Duration({ seconds }: { seconds: number }) {
  return (
    <>
      <span aria-hidden="true">{formatDuration(seconds)}</span>
      <span className="visually-hidden">{spokenDuration(seconds)}</span>
    </>
  );
}

// Native modal dialog: focus is contained, Escape closes and focus returns to
// the opener. Title is the accessible name.
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  useEffect(() => () => {
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={() => { if (opener.current instanceof HTMLElement) opener.current.focus(); }}
    >
      {open && (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

// Data tables keep their semantics and scroll inside a focusable, labelled
// region on narrow screens (WCAG 1.4.10 allows two-dimensional data tables).
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}
