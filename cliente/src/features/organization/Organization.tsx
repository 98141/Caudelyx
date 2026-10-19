import { useEffect, useRef, useState } from 'react';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ASSIGNABLE_BY_ADMIN, ASSIGNABLE_BY_TITULAR, REASON_OPTIONS, ROLE_LABEL, stableIdempotencyKey } from '../../shared/contracts';
import { Alert, Empty, ErrorText, Field, Panel, StepFields, Submit, onSubmit } from '../../shared/ui';

interface Organization { id: string; name: string; timezone: 'America/Bogota'; currency: 'COP'; status: 'ACTIVE' | 'SUSPENDED'; version?: string }
interface Member { userId: string; displayName: string; email: string; roleIds: string[]; status: 'ACTIVE' | 'SUSPENDED' | 'FACTOR_LOSS_BLOCKED'; version: string }
interface Invitation { id: string; email: string; roleIds: string[]; status: string; expiresAt: string; version: string }

export function OrganizationScreen() {
  const { me, refresh } = useAuth();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [membersError, setMembersError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['L']);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [reasonCode, setReasonCode] = useState<'SECURITY' | 'STAFF_CHANGE' | 'OWNER_REQUEST'>('STAFF_CHANGE');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const createKey = useRef({ body: '', key: '' });
  const strong = me?.authState === 'ACTIVE' || me?.authState === 'AUTHENTICATED_NO_ORG';
  const self = members.find(member => member.userId === me?.userId);
  const manager = self?.roleIds.includes('T') || self?.roleIds.includes('A');
  const assignable = self?.roleIds.includes('T') ? ASSIGNABLE_BY_TITULAR : ASSIGNABLE_BY_ADMIN;

  useEffect(() => {
    if (me?.authState !== 'ACTIVE') return;
    void call<Organization>('GET', '/organization').then(result => {
      setOrganization({ ...result.data, version: result.data.version ?? result.etag ?? undefined });
    }).catch(setError);
  }, [me?.authState, info]);

  useEffect(() => {
    if (me?.authState !== 'ACTIVE') return;
    void call<{ items: Member[] }>('GET', '/organization/members').then(result => {
      setMembers(result.data.items);
      setMembersError(null);
    }).catch(setMembersError);
    void call<{ items: Invitation[] }>('GET', '/organization/invitations').then(result => setInvitations(result.data.items)).catch(() => undefined);
  }, [me?.authState, info]);

  if (!strong) {
    return <Panel title="Organización" id="page-title"><Alert tone="info">Hace falta una sesión comprobada con factor. La contraseña o una pre-sesión no abren esta sección.</Alert></Panel>;
  }

  const createBody = { name, timezone: 'America/Bogota' as const, currency: 'COP' as const };
  return (
    <Panel title="Organización" id="page-title">
      <p>El servidor decide permisos, versión y afiliación. Esta pantalla no habilita módulos financieros.</p>
      <ErrorText error={error} />
      {info ? <Alert tone="pending">{info}</Alert> : null}
      {me?.authState === 'AUTHENTICATED_NO_ORG' ? (
        <form onSubmit={onSubmit(async () => {
          const key = stableIdempotencyKey(createKey, createBody);
          await reauthenticate({ password, purpose: 'ORGANIZATION_CREATE', command: createBody, code });
          const result = await call<{ organization: Organization }>('POST', '/organizations', createBody, { idempotencyKey: key });
          setOrganization(result.data.organization);
          setPassword(''); setCode('');
          setInfo('Organización creada. Una segunda organización no está permitida.');
          await refresh();
        }, setPending, setError)}>
          <h2>Crear la organización</h2>
          <Field label="Nombre"><input value={name} onChange={event => setName(event.target.value)} maxLength={120} required /></Field>
          <p className="muted">Zona America/Bogota y moneda COP, fijas por el contrato.</p>
          <StepFields legend="Confirmar creación" password={password} code={code} setPassword={setPassword} setCode={setCode} />
          <Submit pending={pending}>Crear organización</Submit>
        </form>
      ) : null}
      {organization ? (
        <article className="card">
          <h2>{organization.name}</h2>
          <p>{organization.status === 'ACTIVE' ? 'Activa' : 'Suspendida'} · {organization.timezone} · {organization.currency}</p>
          {organization.version ? <p className="muted">Versión opaca lista para If-Match.</p> : <p className="muted">Esta consulta no incluye versión de gestión.</p>}
          {organization.version && manager ? (
            <form onSubmit={onSubmit(async () => {
              await reauthenticate({ password, purpose: 'ORGANIZATION_EDIT', resourceId: organization.id, command: { name }, code });
              const result = await call<Organization>('PATCH', '/organization', { name }, { ifMatch: organization.version });
              setOrganization({ ...result.data, version: result.data.version ?? result.etag ?? organization.version });
              setPassword(''); setCode('');
              setInfo('Nombre actualizado con la versión consultada.');
            }, setPending, setError)}>
              <Field label="Nuevo nombre"><input value={name} onChange={event => setName(event.target.value)} required /></Field>
              <StepFields legend="Confirmar cambio de nombre" password={password} code={code} setPassword={setPassword} setCode={setCode} />
              <Submit pending={pending}>Guardar nombre</Submit>
            </form>
          ) : null}
        </article>
      ) : null}
      {me?.authState === 'ACTIVE' ? (
        <section className="card">
          <h2>Personas</h2>
          {membersError ? <Alert tone="error">La gestión respondió sin permiso. La sesión sigue abierta.</Alert> : null}
          {!membersError && members.length === 0 ? <Empty>No hay personas en esta página.</Empty> : null}
          <div className="cards">
            {members.map(member => (
              <article className="card" key={member.userId}>
                <h3>{member.displayName}</h3>
                <p>{member.email}</p>
                <p>{member.roleIds.map(role => ROLE_LABEL[role] ?? role).join(', ')} · {member.status === 'SUSPENDED' ? 'Suspendida' : member.status === 'FACTOR_LOSS_BLOCKED' ? 'Sin factor' : 'Activa'}</p>
                {member.userId === me.userId ? <p>Este es tu usuario.</p> : null}
                {manager && member.userId !== me.userId ? (
                  <MemberActions member={member} assignable={assignable} password={password} code={code} setPassword={setPassword} setCode={setCode} reasonCode={reasonCode} setReasonCode={setReasonCode} onDone={message => { setInfo(message); setPassword(''); setCode(''); }} />
                ) : null}
              </article>
            ))}
          </div>
          {manager ? (
            <form onSubmit={onSubmit(async () => {
              const command = { email, roleIds: roles };
              await reauthenticate({ password, purpose: 'MEMBER_INVITE', resourceId: me.organizationId, command, code });
              await call('POST', '/organization/invitations', command);
              setEmail(''); setPassword(''); setCode('');
              setInfo('Invitación aceptada para envío. Prepararla no afilia a la persona.');
            }, setPending, setError)}>
              <h2>Invitar</h2>
              <p>No se puede asignar titular ni superadmin. El servidor aplica la jerarquía.</p>
              <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" required /></Field>
              <RolePicker roles={roles} setRoles={setRoles} assignable={assignable} />
              <StepFields legend="Confirmar invitación" password={password} code={code} setPassword={setPassword} setCode={setCode} />
              <Submit pending={pending}>Enviar invitación</Submit>
            </form>
          ) : null}
          <div className="cards">
            {invitations.map(invitation => (
              <article className="card" key={invitation.id}>
                <h3>{invitation.email}</h3>
                <p>{invitation.status} · vence {new Date(invitation.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
                {manager && invitation.status === 'PENDING' ? <button type="button" onClick={() => void revokeInvitation(invitation).catch(setError)}>Revocar invitación</button> : null}
              </article>
            ))}
          </div>
          {self?.roleIds.includes('T') && organization?.version ? (
            <form onSubmit={onSubmit(async () => {
              await reauthenticate({ password, purpose: 'ORGANIZATION_SESSIONS_REVOKE', resourceId: organization.id, code });
              const result = await call<{ revokedCount: number }>('POST', '/organization/sessions/revoke-all', { reasonCode }, { ifMatch: organization.version });
              setInfo(`Sesiones operativas cerradas: ${result.data.revokedCount}. El recuento no incluye pre-sesiones.`);
              await refresh();
            }, setPending, setError)}>
              <h2>Cerrar sesiones de la organización</h2>
              <Reason value={reasonCode} setValue={setReasonCode} />
              <StepFields legend="Confirmar cierre de la organización" password={password} code={code} setPassword={setPassword} setCode={setCode} />
              <Submit pending={pending}>Cerrar sesiones operativas</Submit>
            </form>
          ) : null}
        </section>
      ) : null}
    </Panel>
  );

  async function revokeInvitation(invitation: Invitation) {
    await reauthenticate({ password, purpose: 'INVITATION_REVOKE', resourceId: invitation.id, code });
    await call('DELETE', `/organization/invitations/${invitation.id}`, undefined, { ifMatch: invitation.version });
    setInfo('Invitación revocada.');
    setInvitations(invitations.filter(item => item.id !== invitation.id));
  }
}

function RolePicker({ roles, setRoles, assignable }: { roles: string[]; setRoles: (roles: string[]) => void; assignable: readonly string[] }) {
  return (
    <div className="checks">
      {assignable.map(role => (
        <label key={role}><input type="checkbox" checked={roles.includes(role)} onChange={event => setRoles(event.target.checked ? [...roles, role] : roles.filter(item => item !== role))} /> {ROLE_LABEL[role]}</label>
      ))}
    </div>
  );
}

function Reason({ value, setValue }: { value: string; setValue: (value: 'SECURITY' | 'STAFF_CHANGE' | 'OWNER_REQUEST') => void }) {
  return (
    <Field label="Motivo">
      <select value={value} onChange={event => setValue(event.target.value as 'SECURITY' | 'STAFF_CHANGE' | 'OWNER_REQUEST')}>
        {REASON_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  );
}

function MemberActions(props: {
  member: Member; assignable: readonly string[]; password: string; code: string;
  setPassword: (value: string) => void; setCode: (value: string) => void;
  reasonCode: 'SECURITY' | 'STAFF_CHANGE' | 'OWNER_REQUEST';
  setReasonCode: (value: 'SECURITY' | 'STAFF_CHANGE' | 'OWNER_REQUEST') => void;
  onDone: (message: string) => void;
}) {
  const [roles, setRoles] = useState(props.member.roleIds.filter(role => props.assignable.includes(role)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form onSubmit={onSubmit(async () => {
      const command = { roleIds: roles };
      await reauthenticate({ password: props.password, purpose: 'MEMBER_ROLE_CHANGE', resourceId: props.member.userId, command, code: props.code });
      await call('PATCH', `/organization/members/${props.member.userId}/roles`, command, { ifMatch: props.member.version });
      props.onDone('Roles enviados con la versión de la persona.');
    }, setPending, setError)}>
      <ErrorText error={error} />
      <RolePicker roles={roles} setRoles={setRoles} assignable={props.assignable} />
      <StepFields legend={`Confirmar a ${props.member.displayName}`} password={props.password} code={props.code} setPassword={props.setPassword} setCode={props.setCode} />
      <Reason value={props.reasonCode} setValue={props.setReasonCode} />
      <Submit pending={pending}>Cambiar roles</Submit>
      <button type="button" onClick={() => void memberCommand('suspend').catch(setError)}>Suspender</button>
      <button type="button" onClick={() => void memberCommand('reactivate').catch(setError)}>Reactivar</button>
      <button type="button" onClick={() => void memberCommand('revoke').catch(setError)}>Cerrar sus sesiones</button>
    </form>
  );

  async function memberCommand(kind: 'suspend' | 'reactivate' | 'revoke') {
    const purpose = kind === 'suspend' ? 'MEMBER_SUSPEND' : kind === 'reactivate' ? 'MEMBER_REACTIVATE' : 'MEMBER_SESSIONS_REVOKE';
    await reauthenticate({ password: props.password, purpose, resourceId: props.member.userId, code: props.code });
    const path = kind === 'revoke' ? `/organization/members/${props.member.userId}/sessions/revoke` : `/organization/members/${props.member.userId}/${kind}`;
    const result = await call<{ status?: string; revokedCount?: number }>( 'POST', path, { reasonCode: props.reasonCode }, { ifMatch: props.member.version });
    props.onDone(kind === 'revoke' ? `Sesiones operativas cerradas: ${result.data.revokedCount ?? 0}.` : `Estado resultante: ${result.data.status ?? 'actualizado'}.`);
  }
}
