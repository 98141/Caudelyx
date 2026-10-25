import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from './contracts';

export function LocalMailboxHint({ email }: { email?: string }) {
  if (import.meta.env.VITE_CAUDELYX_MODE !== 'local-synthetic') return null;
  return <p className="muted">Modo local sintético. En otra terminal del producto ejecuta npm run mailbox -- --email {email ?? 'el correo de esta solicitud'}. El enlace se imprime solo allí y esta pantalla no lo confirma.</p>;
}

const ALERT_MARK: Record<'error' | 'info' | 'pending' | 'ok', string> = {
  error: 'M12 8v5M12 16.5h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  pending: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  info: 'M12 11v5M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  ok: 'M8 12.5l2.5 2.5L16 9M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
};

export function Alert({ tone, children }: { tone: 'error' | 'info' | 'pending' | 'ok'; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <svg className="alert-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={ALERT_MARK[tone]} />
      </svg>
      {children}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {children}
      </label>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function SecretTextField({ label, value, onChange, autoComplete, hint, invalid = false }: {
  label: string; value: string; onChange: (value: string) => void; autoComplete: string; hint?: string; invalid?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => onChangeRef.current(''), []);
  return (
    <div className="password-line">
      <Field label={label} hint={hint}>
        <input value={value} onChange={event => onChange(event.target.value)} type={visible ? 'text' : 'password'} autoComplete={autoComplete} minLength={15} maxLength={128} required spellCheck={false} aria-invalid={invalid || undefined} />
      </Field>
      <button className="secret-toggle" type="button" data-visible={visible ? 'true' : 'false'} onClick={() => setVisible(current => !current)}>{visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}</button>
    </div>
  );
}

export function Submit({ pending, children, disabled = false }: { pending: boolean; children: string; disabled?: boolean }) {
  return <button className="primary" type="submit" disabled={pending || disabled} aria-busy={pending}>{pending ? 'Enviando…' : children}</button>;
}

export function Panel({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <h1 id={id} tabIndex={-1}>{title}</h1>
      {children}
    </section>
  );
}

export function useErrorFocus(error: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  return ref;
}

export function ErrorText({ error }: { error: unknown }) {
  const ref = useErrorFocus(error ? '1' : null);
  if (!error) return null;
  const text = error instanceof ApiError ? error.message : 'No se pudo completar la acción.';
  return <div ref={ref} tabIndex={-1}><Alert tone="error">{text}</Alert></div>;
}

export function onSubmit(handler: () => Promise<void>, setPending: (value: boolean) => void, setError: (error: unknown) => void) {
  return (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    void handler().catch(setError).finally(() => setPending(false));
  };
}

export function SecretOnce({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  const id = useId();
  return (
    <div className="secret">
      <p id={id}>{label}</p>
      <output aria-labelledby={id}>{value}</output>
      <button type="button" onClick={onClear}>Ocultar y borrar de la pantalla</button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function StepFields({ legend, password, code, setPassword, setCode }: {
  legend: string; password: string; code: string; setPassword: (value: string) => void; setCode: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <Field label="Contraseña actual" hint="Se usa solo para este paso y no se guarda en el navegador.">
        <input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" minLength={15} maxLength={128} required />
      </Field>
      <Field label="Código TOTP vigente" hint="Introduce el código actual de 30 segundos, o deja el campo vacío para confirmar con tu passkey.">
        <input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} />
      </Field>
    </fieldset>
  );
}
