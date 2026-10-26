import { useEffect, useState } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { inOrganization, isStrong } from '../../shared/contracts';
import { Alert, Panel } from '../../shared/ui';

interface Step { id: string; label: string; done: boolean; href: string }

export function HomeScreen() {
  const { me, phase } = useAuth();
  const [progress, setProgress] = useState<{authority:string;steps:Step[]}>({authority:'',steps:[]});
  const [error, setError] = useState<string | null>(null);
  const organizationId = me?.organizationId ?? '';

  const working = inOrganization(me);
  const confirmed = me?.profile?.emailVerified === true;
  const authority = `${me?.userId ?? ''}:${organizationId}:${working}:${JSON.stringify([...(me?.roleIds ?? [])].sort())}`;
  const steps = progress.authority === authority ? progress.steps : [];

  useEffect(() => {
    let live = true;
    const next: Step[] = [
      { id: 'org', label: 'Crear la organización', done: working, href: '#/organizacion' },
      { id: 'caja', label: 'Crear una caja o un banco', done: false, href: '#/finanzas' },
      { id: 'saldo', label: 'Registrar el saldo inicial, si el libro está vacío', done: false, href: '#/finanzas' },
      { id: 'persona', label: 'Registrar un prestatario', done: false, href: '#/prestatarios' },
      { id: 'prestamo', label: 'Crear un préstamo', done: false, href: '#/prestamos' },
    ];
    if (!working || !organizationId) {
      if (live) setProgress({authority,steps:next});
      return () => { live = false; };
    }
    const base = `/organizations/${organizationId}/financial`;
    void (async () => {
      try {
        const [accounts, journals, borrowers, loans] = await Promise.all([
          call<{ items: { kind: string }[] }>('GET', `${base}/accounts?limit=20`),
          call<{ items: unknown[] }>('GET', `${base}/journal-entries?limit=1`),
          call<{ items: unknown[] }>('GET', `/organizations/${organizationId}/borrowers?limit=1`),
          call<{ items: unknown[] }>('GET', `/organizations/${organizationId}/loans?limit=1`),
        ]);
        if (!live) return;
        next[1]!.done = accounts.data.items.some(item => item.kind === 'CASH' || item.kind === 'BANK');
        next[2]!.done = journals.data.items.length > 0;
        next[3]!.done = borrowers.data.items.length > 0;
        next[4]!.done = loans.data.items.length > 0;
        setProgress({authority,steps:next});
        setError(null);
      } catch {
        if (live) {
          setProgress({authority,steps:next});
          setError('No se pudieron leer los pasos de la organización. No se muestran cifras de otra cuenta.');
        }
      }
    })();
    return () => { live = false; };
  }, [authority, working, organizationId]);

  if (phase === 'loading') return <Panel title="Inicio" id="page-title"><p role="status">Cargando sesión…</p></Panel>;
  if (!isStrong(me) && me?.authState !== 'PENDING_EMAIL') return <Panel title="Inicio" id="page-title"><p>Ingresa para ver el siguiente paso de esta cuenta.</p></Panel>;
  const current = steps.find(step => !step.done);
  return (
    <Panel title="Inicio" id="page-title">
      <p>Cinco pasos de esta sesión. La siguiente acción es la primera que todavía no está hecha.</p>
      {!confirmed ? <Alert tone="pending">Confirma tu correo para continuar. <a href="#/perfil">Ir a mi cuenta</a></Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ol className="steps">
        {steps.map((step, index) => (
          <li key={step.id} aria-current={!step.done && current?.id === step.id ? 'step' : undefined}>
            {index + 1}. {step.label}. {step.done ? 'Hecho' : 'Pendiente'}
            {!step.done && current?.id === step.id ? <> <a href={step.href}>Continuar</a></> : null}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
