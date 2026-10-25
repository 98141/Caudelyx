import { useEffect, useState } from 'react';
import { clearActivationLink, peekActivation } from '../../shared/activation-link';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, isStrong, type Me } from '../../shared/contracts';
import { Alert, ErrorText, Field, LocalMailboxHint, Panel, SecretTextField, Submit, onSubmit } from '../../shared/ui';
import { FirstFactorSetup, SecurityGateLink, SecurityMenu } from '../security/Security';

function go(hash: string) { window.location.hash = hash; }

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : parts[0]?.[1] ?? '';
  return `${first}${last}`.toLocaleUpperCase('es-CO');
}

function basicSession(me: Me | null): boolean {
  return me?.sessionContext === 'B' || me?.authState === 'PENDING_EMAIL' || me?.authState === 'EMAIL_REQUIRED';
}

export function ProfileScreen() {
  const { me, phase, refresh } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const [initialSent, setInitialSent] = useState(false);
  const [name, setName] = useState(me?.profile?.displayName ?? '');
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setName(me?.profile?.displayName ?? ''); }, [me?.profile?.displayName]);
  const provisional = me?.authState === 'EMAIL_REQUIRED' || me?.authState === 'PENDING_EMAIL';
  const canEnroll = me?.nextAction === 'ENROLL_FIRST_FACTOR';
  const needsInitial = me?.authState === 'MFA_ENROLLMENT' && !canEnroll && me.sessionContext !== 'B';
  const mailPending = provisional || me?.profile?.emailVerified === false;
  const savedName = me?.profile?.displayName ?? '';
  const dirty = name.trim() !== savedName.trim();
  const securityHub = me?.authState !== 'EMAIL_REQUIRED'
    && me?.authState !== 'PENDING_EMAIL'
    && me?.nextAction !== 'ENROLL_FIRST_FACTOR'
    && me?.authState !== 'MFA_ENROLLMENT';
  return (
    <Panel title="Mi cuenta" id="page-title">
      <div className="account-center">
      <p className="profile-lead">Administra tu información personal y la configuración de tu cuenta</p>
      {phase === 'loading' ? <p role="status">Cargando sesión…</p> : null}
      {mailPending && me?.profile ? <p>Activa tu cuenta para continuar</p> : null}
      {mailPending && me?.profile ? <Alert tone="pending">Confirma tu correo para crear organizaciones.</Alert> : null}
      {basicSession(me) ? <p>Esta sesión no abre organizaciones ni finanzas.</p> : null}
      <ErrorText error={error} />
      {saved ? <Alert tone="ok">Nombre actualizado.</Alert> : null}
      {me?.profile ? (
        <div className="profile-layout">
          <section className="profile-card" aria-labelledby="datos-personales">
            <h2 id="datos-personales">Información personal</h2>
            <div className="account-person">
              <span className="profile-avatar" aria-hidden="true">{initials(me.profile.displayName)}</span>
              <p className="muted">El correo no se edita desde esta pantalla.</p>
            </div>
            <dl className="account-facts">
              <div>
                <dt>Nombre completo</dt>
                <dd className="profile-name">Nombre: {me.profile.displayName}</dd>
              </div>
              <div>
                <dt>Correo electrónico</dt>
                <dd className="profile-email">Correo: {me.profile.email}</dd>
              </div>
              <div>
                <dt>Verificación</dt>
                <dd className={me.profile.emailVerified ? 'profile-status is-ok' : 'profile-status is-pending'}>{me.profile.emailVerified ? 'Correo confirmado' : 'Correo sin confirmar'}</dd>
              </div>
              {me.profile.createdAt ? (
                <div>
                  <dt>Fecha de registro</dt>
                  <dd>Fecha de alta: {new Date(me.profile.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</dd>
                </div>
              ) : null}
            </dl>
            {me.profile.version && !editing ? <button type="button" className="account-edit" onClick={() => { setEditing(true); setSaved(false); }}>Editar información</button> : null}
            {me.profile.version && editing ? (
              <form className="account-editor" onSubmit={onSubmit(async () => {
                const result = await call<NonNullable<Me['profile']>>('PATCH', '/auth/profile', { displayName: name.trim() }, { ifMatch: me.profile?.version });
                setName(result.data.displayName);
                setSaved(true);
                setEditing(false);
                await refresh();
              }, setPending, setError)}>
                <Field label="Nombre completo"><input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} autoComplete="name" minLength={1} maxLength={100} required /></Field>
                {dirty ? (
                  <div className="profile-actions">
                    <Submit pending={pending}>Guardar cambios</Submit>
                    <button type="button" disabled={pending} onClick={() => { setName(savedName); setSaved(false); setError(null); setEditing(false); }}>Cancelar</button>
                  </div>
                ) : <button type="button" onClick={() => setEditing(false)}>Cerrar edición</button>}
              </form>
            ) : null}
          </section>
          <section className="profile-card" aria-labelledby="estado-seguridad">
            <h2 id="estado-seguridad">Seguridad de la cuenta</h2>
            {me.profile.hasFactor === true ? <p>Hay un factor registrado.</p> : null}
            {me.profile.hasFactor === false ? <p>Falta segundo factor</p> : null}
            {securityHub ? <SecurityMenu strong={isStrong(me)} /> : (
              <SecurityGateLink text={me.profile.emailVerified === false || me.authState === 'EMAIL_REQUIRED' || me.authState === 'PENDING_EMAIL'
                ? 'Confirma el correo antes de administrar métodos, contraseña, códigos y sesiones.'
                : 'Primero se registra el factor. Contraseña, códigos y sesiones se abren después.'} />
            )}
          </section>
        </div>
      ) : phase === 'anonymous' ? <p>No hay un perfil en este navegador. <a href="#/registro">Crear cuenta</a> o <a href="#/ingresar">ingresar</a>.</p> : null}
      {mailPending && me?.profile ? (
        <>
          <p>Crear una organización sigue bloqueado hasta confirmar el correo y registrar un factor.</p>
          <LocalMailboxHint email={me.profile.email} />
          <button type="button" disabled={pending} onClick={() => {
            setError(null); setPending(true);
            void call('POST', '/auth/email-verifications/request', { purpose: 'ACTIVATION', email: me.profile?.email })
              .then(() => setSent(true)).catch(setError).finally(() => setPending(false));
          }}>Reenviar enlace de activación</button>
          {sent ? <Alert tone="pending">Solicitud recibida. Revisa el canal local. Esto no dice si el correo existe.</Alert> : null}
        </>
      ) : null}
      {needsInitial ? (
        <section>
          <h2>Proteger mi cuenta</h2>
          <p>Este ingreso no trae el alta del factor. Pide un enlace nuevo y ábrelo en este mismo navegador.</p>
          <button type="button" disabled={pending} onClick={() => {
            setError(null); setPending(true);
            void call('POST', '/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' })
              .then(() => setInitialSent(true)).catch(setError).finally(() => setPending(false));
          }}>Pedir enlace de protección</button>
          {initialSent ? <Alert tone="pending">Solicitud recibida. Abre el enlace del canal local en este mismo ingreso. Esto no abre la organización.</Alert> : null}
        </section>
      ) : null}
      {canEnroll ? <FirstFactorSetup /> : null}
      {me?.authState === 'MFA_REQUIRED' ? <p>Falta comprobar el factor que ya tienes. <a href="#/ingresar">Comprobar el factor</a></p> : null}
      {me?.authState === 'FACTOR_LOSS_BLOCKED' || me?.authState === 'RECOVERY_RESTRICTED' ? <p><a href="#/seguridad">Revisar la seguridad de la cuenta</a></p> : null}
      {isStrong(me) ? <p><a href="#/organizacion">Continuar a la organización</a></p> : null}
      </div>
    </Panel>
  );
}

export function ActivateScreen() {
  const { me, phase, refresh } = useAuth();
  const [, setLinkTick] = useState(0);
  useEffect(() => {
    const sync = () => {
      setLinkTick(value => value + 1);
      if (peekActivation()?.status === 'ready') {
        setLegacyRequired(false);
        setLegacyConfirmed(false);
        setLegacyFailed(false);
        setPassword('');
        setError(null);
      }
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const link = peekActivation();
  const [password, setPassword] = useState('');
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const [legacyRequired, setLegacyRequired] = useState(false);
  const [legacyFailed, setLegacyFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [initialBlocked, setInitialBlocked] = useState(false);
  const [confirmed, setConfirmed] = useState<'login' | 'profile' | 'rejected' | null>(null);
  const ready = link?.status === 'ready' ? link : null;
  const initialOriginal = me?.authState === 'MFA_ENROLLMENT' && me.nextAction !== 'ENROLL_FIRST_FACTOR';

  useEffect(() => {
    if (phase === 'loading' || !ready || ready.purpose !== 'INITIAL_MFA_PROOF' || initialOriginal) return;
    clearActivationLink();
    setInitialBlocked(true);
  }, [phase, ready, initialOriginal]);

  async function finish() {
    setPassword('');
    clearActivationLink();
    await refresh();
    go('#/perfil');
  }

  if (phase === 'loading') return <Panel title="Activar" id="page-title"><p role="status">Cargando sesión…</p></Panel>;
  if (confirmed === 'rejected') {
    return <Panel title="No fui yo" id="page-title"><Alert tone="pending">La solicitud quedó anulada. No queda una sesión de esa cuenta en este navegador.</Alert></Panel>;
  }
  if (confirmed === 'login') {
    return (
      <Panel title="Activar" id="page-title">
        <p>Correo confirmado ✓</p>
        <p>Este navegador no recibió la sesión de esa cuenta. <a href="#/ingresar">Ingresar</a></p>
      </Panel>
    );
  }
  if (ready?.purpose === 'REJECT' || window.location.hash.split('?')[0] === '#/rechazar') {
    return (
      <Panel title="No fui yo" id="page-title">
        <p>Confirma solo si no creaste la cuenta. Abrir esta página no la anula.</p>
        <ErrorText error={error} />
        {ready?.purpose === 'REJECT' ? (
          <form onSubmit={onSubmit(async () => {
            const live = peekActivation();
            if (!live || live.status !== 'ready' || live.purpose !== 'REJECT') return;
            await call('POST', '/auth/registrations/reject', { token: live.token });
            clearActivationLink();
            setConfirmed('rejected');
            await refresh();
          }, setPending, setError)}>
            <Submit pending={pending}>No fui yo</Submit>
          </form>
        ) : <p>Abre el enlace del canal local. No pegues el código en esta página.</p>}
      </Panel>
    );
  }
  if (legacyFailed) {
    return (
      <Panel title="Activar" id="page-title">
        <ErrorText error={error} />
        <p>No se activó la cuenta. Puedes empezar un alta nueva.</p>
        <p><a href="#/registro">Empezar un alta nueva</a></p>
      </Panel>
    );
  }
  if (initialBlocked) {
    return (
      <Panel title="Activar" id="page-title">
        <p>Este enlace solo vale en el ingreso donde se pidió. Si saliste o cambiaste de cuenta, pide otro. No se usó este.</p>
        <p><a href="#/ingresar">Volver a ingresar</a></p>
      </Panel>
    );
  }
  if (!link) {
    return <Panel title="Activar" id="page-title"><p>Abre el enlace del canal local. No pegues el código en esta página.</p></Panel>;
  }
  if (link.status === 'invalid' || !ready) {
    return <Panel title="Activar" id="page-title"><Alert tone="error">Este enlace no se puede usar. Pide otro en el canal local. No pegues el código.</Alert></Panel>;
  }

  if (ready.purpose === 'INITIAL_MFA_PROOF' && !initialOriginal) {
    return (
      <Panel title="Activar" id="page-title">
        <p>Este enlace solo vale en el ingreso donde se pidió. Si saliste o cambiaste de cuenta, pide otro. No se usó este.</p>
        <p><a href="#/ingresar">Volver a ingresar</a></p>
      </Panel>
    );
  }

  if (ready.purpose === 'INITIAL_MFA_PROOF') {
    return (
      <Panel title="Activar" id="page-title">
        <p>Confirma el enlace para poder proteger la cuenta. No se envía otra contraseña.</p>
        <ErrorText error={error} />
        <form onSubmit={onSubmit(async () => {
          const live = peekActivation();
          if (!live || live.status !== 'ready') return;
          await call<Me>('POST', '/auth/email-verifications/confirm', { purpose: 'INITIAL_MFA_PROOF', token: live.token });
          await finish();
        }, setPending, setError)}>
          <Submit pending={pending}>Confirmar enlace</Submit>
        </form>
      </Panel>
    );
  }

  if (ready.purpose === 'ACTIVATION' && !legacyRequired) {
    return (
      <Panel title="Activar" id="page-title">
        <p>Confirma el enlace. Esta alta no pide otra contraseña.</p>
        <ErrorText error={error} />
        <form onSubmit={onSubmit(async () => {
          const live = peekActivation();
          if (!live || live.status !== 'ready') return;
          try {
            const result = await call<{ emailVerified?: boolean; nextAction?: string }>('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token: live.token });
            if (result.data.emailVerified !== true) throw new ApiError(502, 'INPUT_INVALID', result.requestId, 'La respuesta no confirmó el correo. No se mostró la marca.');
            clearActivationLink();
            if (result.data.nextAction === 'PROFILE') {
              setConfirmed('profile');
              await refresh();
              go('#/perfil');
              return;
            }
            setConfirmed('login');
            await refresh();
          } catch (caught) {
            if (caught instanceof ApiError && caught.status === 422 && caught.code === 'INPUT_INVALID') {
              setLegacyRequired(true);
              setError(caught);
              return;
            }
            throw caught;
          }
        }, setPending, setError)}>
          <Submit pending={pending}>Activar cuenta</Submit>
        </form>
      </Panel>
    );
  }

  if (!legacyConfirmed) {
    return (
      <Panel title="Activar" id="page-title">
        <p>{legacyRequired
          ? 'El servidor pidió la primera contraseña de una invitación. No se usa para un alta que ya tiene contraseña.'
          : 'El servidor todavía no autorizó una contraseña en este enlace.'}</p>
        <ErrorText error={error} />
        <button type="button" onClick={() => setLegacyConfirmed(true)}>Crear contraseña inicial</button>
        <p><a href="#/registro">Empezar un alta nueva</a></p>
      </Panel>
    );
  }

  return (
    <Panel title="Activar" id="page-title">
      <p>La contraseña inicial solo se envía porque elegiste usar la alternativa de este enlace.</p>
      <ErrorText error={error} />
      <form onSubmit={onSubmit(async () => {
        const live = peekActivation();
        if (!live || live.status !== 'ready') return;
        try {
          await call<Me>('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: live.token, newPassword: password });
          await finish();
        } catch (error) {
          setLegacyFailed(true);
          throw error;
        } finally {
          setPassword('');
          clearActivationLink();
        }
      }, setPending, setError)}>
        <SecretTextField label="Contraseña nueva" value={password} onChange={setPassword} autoComplete="new-password" hint="Entre 15 y 128 caracteres. El servidor aplica la lista local." />
        <Submit pending={pending}>Activar con contraseña inicial</Submit>
      </form>
    </Panel>
  );
}
