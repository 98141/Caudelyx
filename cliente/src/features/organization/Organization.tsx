import { useEffect, useRef, useState } from 'react';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, ASSIGNABLE_BY_ADMIN, ASSIGNABLE_BY_TITULAR, REASON_OPTIONS, ROLE_LABEL, stableIdempotencyKey } from '../../shared/contracts';
import { Alert, Empty, ErrorText, Field, Panel, StepFields, Submit, onSubmit } from '../../shared/ui';

const TENANT_ROLES = ['T', 'A', 'O', 'C', 'P', 'L'] as const;
const PAGE_LIMIT = 20;

interface Organization { id: string; name: string; timezone: 'America/Bogota'; currency: 'COP'; status: 'ACTIVE' | 'SUSPENDED'; version?: string }
interface Member { userId: string; displayName: string; email: string; roleIds: string[]; status: 'ACTIVE' | 'SUSPENDED' | 'FACTOR_LOSS_BLOCKED'; version: string }
interface Invitation { id: string; email: string; roleIds: string[]; status: string; expiresAt: string; version: string }
interface Page<T> { items: T[]; nextCursor?: string | null }

function ownRoles(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return null;
  if (new Set(value).size !== value.length) return null;
  if (value.some(role => typeof role !== 'string' || !TENANT_ROLES.includes(role as typeof TENANT_ROLES[number]))) return null;
  return value;
}

function pageQuery(cursor: string | null): string {
  if (!cursor) return '';
  return `?${new URLSearchParams({ limit: String(PAGE_LIMIT), cursor }).toString()}`;
}

function mergePage<T>(current: T[], incoming: T[], cursor: string | null, id: (item: T) => string): T[] {
  const base = cursor ? current : [];
  const seen = new Set(base.map(id));
  const next = [...base];
  for (const item of incoming) {
    const key = id(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function nextCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function OrganizationScreen() {
  const { me, refresh } = useAuth();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [actorRoleIds, setActorRoleIds] = useState<string[] | null>(null);
  const [roleState, setRoleState] = useState<'pending' | 'ready' | 'closed'>('pending');
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [invitationsCursor, setInvitationsCursor] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<unknown>(null);
  const [invitationsError, setInvitationsError] = useState<unknown>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [invitationsLoading, setInvitationsLoading] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['L']);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [reasonCode, setReasonCode] = useState<'SECURITY' | 'STAFF_CHANGE' | 'OWNER_REQUEST'>('STAFF_CHANGE');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const createKey = useRef({ body: '', key: '' });
  const listEpoch = useRef(0);
  const orgEpoch = useRef(0);
  const membersBusy = useRef(false);
  const invitationsBusy = useRef(false);
  const strong = me?.authState === 'ACTIVE' || me?.authState === 'AUTHENTICATED_NO_ORG';
  const manager = roleState === 'ready' && (actorRoleIds?.includes('T') === true || actorRoleIds?.includes('A') === true);
  const assignable = actorRoleIds?.includes('T') ? ASSIGNABLE_BY_TITULAR : ASSIGNABLE_BY_ADMIN;

  useEffect(() => {
    if (me?.authState !== 'ACTIVE') {
      setRoleState('pending');
      setActorRoleIds(null);
      return;
    }
    const epoch = ++orgEpoch.current;
    setRoleState('pending');
    setActorRoleIds(null);
    void call<Organization & { actorRoleIds?: unknown }>('GET', '/organization').then(result => {
      if (epoch !== orgEpoch.current) return;
      const received = ownRoles(result.data.actorRoleIds);
      setOrganization({
        id: result.data.id,
        name: result.data.name,
        timezone: result.data.timezone,
        currency: result.data.currency,
        status: result.data.status,
        version: result.data.version ?? result.etag ?? undefined,
      });
      setActorRoleIds(received);
      setRoleState(received ? 'ready' : 'closed');
    }).catch(reason => {
      if (epoch !== orgEpoch.current) return;
      setActorRoleIds(null);
      setRoleState('closed');
      setError(reason);
    });
  }, [me?.authState, me?.organizationId, reload]);

  useEffect(() => {
    if (me?.authState !== 'ACTIVE') return;
    const epoch = ++listEpoch.current;
    membersBusy.current = false;
    invitationsBusy.current = false;
    setMembers([]);
    setInvitations([]);
    setMembersCursor(null);
    setInvitationsCursor(null);
    setMembersError(null);
    setInvitationsError(null);
    void loadMembers(null, epoch);
    void loadInvitations(null, epoch);
  }, [me?.authState, me?.organizationId, reload]);

  if (!strong) {
    const pendingMail = me?.authState === 'PENDING_EMAIL' || me?.authState === 'EMAIL_REQUIRED' || me?.profile?.emailVerified === false;
    return (
      <Panel title="Organización" id="page-title">
        <div className="account-center">
          <div className="org-sheet">
            <h2>Protege tu cuenta</h2>
            {pendingMail ? <p>Confirma tu correo para crear organizaciones. No se consultan datos de negocio.</p> : <p>Falta registrar un factor. Primero se vuelve a pedir la contraseña. No se consultan datos de negocio.</p>}
            <p>{pendingMail ? <a href="#/perfil">Ir al perfil</a> : <a href="#/seguridad">Registrar el factor</a>}</p>
          </div>
        </div>
      </Panel>
    );
  }

  const createBody = { name, timezone: 'America/Bogota' as const, currency: 'COP' as const };
  const membersDenied = membersError instanceof ApiError && (membersError.status === 403 || membersError.code === 'ACCESS_DENIED');
  return (
    <Panel title="Organización" id="page-title">
      <div className="account-center">
      <p className="profile-lead">Aquí ves tu organización y, cuando tu acceso quede confirmado, las personas y las acciones que te corresponden.</p>
      <ErrorText error={error} />
      {info ? <Alert tone="pending">{info}</Alert> : null}
      {me?.authState === 'AUTHENTICATED_NO_ORG' ? (
        <form className="org-sheet" onSubmit={onSubmit(async () => {
          const key = stableIdempotencyKey(createKey, createBody);
          await reauthenticate({ password, purpose: 'ORGANIZATION_CREATE', command: createBody, code });
          const result = await call<{ organization: Organization }>('POST', '/organizations', createBody, { idempotencyKey: key });
          setOrganization({
            id: result.data.organization.id,
            name: result.data.organization.name,
            timezone: result.data.organization.timezone,
            currency: result.data.organization.currency,
            status: result.data.organization.status,
          });
          setActorRoleIds(null);
          setRoleState('pending');
          setPassword(''); setCode('');
          setInfo('Organización creada. Una segunda organización no está permitida.');
          await refresh();
          setReload(value => value + 1);
        }, setPending, setError)}>
          <h2>Crear la organización</h2>
          <Field label="Nombre"><input value={name} onChange={event => setName(event.target.value)} maxLength={120} required /></Field>
          <p className="muted">Zona America/Bogota y moneda COP, fijas por el contrato.</p>
          <StepFields legend="Confirmar creación" password={password} code={code} setPassword={setPassword} setCode={setCode} />
          <Submit pending={pending}>Crear organización</Submit>
        </form>
      ) : null}
      {organization ? (
        <section className="profile-card" aria-labelledby="org-nombre">
          <h2 id="org-nombre">{organization.name}</h2>
          <dl className="account-facts">
            <div>
              <dt>Estado</dt>
              <dd className={organization.status === 'ACTIVE' ? 'profile-status is-ok' : 'profile-status is-pending'}>{organization.status === 'ACTIVE' ? 'Activa' : 'Suspendida'}</dd>
            </div>
            <div>
              <dt>Zona horaria</dt>
              <dd>{organization.timezone}</dd>
            </div>
            <div>
              <dt>Moneda</dt>
              <dd>{organization.currency}</dd>
            </div>
          </dl>
          {organization.status === 'ACTIVE' && actorRoleIds?.includes('T') ? <p><a className="org-action" href="#/finanzas">Abrir el libro de cuentas</a></p> : null}
          {organization.version ? <p className="muted">Versión opaca lista para If-Match.</p> : <p className="muted">Esta consulta no incluye versión de gestión.</p>}
          {organization.version && manager ? (
            <form className="org-sheet" onSubmit={onSubmit(async () => {
              await reauthenticate({ password, purpose: 'ORGANIZATION_EDIT', resourceId: organization.id, command: { name }, code });
              const result = await call<Organization>('PATCH', '/organization', { name }, { ifMatch: organization.version });
              setOrganization({
                id: result.data.id,
                name: result.data.name,
                timezone: result.data.timezone,
                currency: result.data.currency,
                status: result.data.status,
                version: result.data.version ?? result.etag ?? organization.version,
              });
              setPassword(''); setCode('');
              setInfo('Nombre actualizado con la versión consultada.');
              setReload(value => value + 1);
            }, setPending, setError)}>
              <Field label="Nuevo nombre"><input value={name} onChange={event => setName(event.target.value)} required /></Field>
              <StepFields legend="Confirmar cambio de nombre" password={password} code={code} setPassword={setPassword} setCode={setCode} />
              <Submit pending={pending}>Guardar nombre</Submit>
            </form>
          ) : null}
        </section>
      ) : null}
      {me?.authState === 'ACTIVE' ? (
        <section className="profile-card">
          <h2>Personas</h2>
          {roleState === 'closed' ? <Alert tone="error">No se puede mostrar la gestión: la consulta no trajo roles propios válidos.</Alert> : null}
          {roleState === 'pending' ? <p role="status">Comprobando tu acceso antes de mostrar personas y acciones.</p> : null}
          {membersDenied ? <Alert tone="error">La gestión respondió sin permiso. La sesión sigue abierta.{membersError instanceof ApiError && membersError.requestId ? ` Referencia ${membersError.requestId}.` : ''}</Alert> : null}
          {!membersDenied && membersError ? <ErrorText error={membersError} /> : null}
          {roleState !== 'pending' && membersLoading && members.length === 0 ? <p role="status">Cargando personas...</p> : null}
          {roleState !== 'pending' && !membersError && !membersLoading && members.length === 0 ? <Empty>No hay personas en esta página.</Empty> : null}
          {roleState === 'pending' ? null : <div className="org-people">
            {members.map(member => (
              <article className="org-member" key={member.userId}>
                <h3>{member.displayName}</h3>
                <p>{member.email}</p>
                <p>{member.roleIds.map(role => ROLE_LABEL[role] ?? role).join(', ')} · {member.status === 'SUSPENDED' ? 'Suspendida' : member.status === 'FACTOR_LOSS_BLOCKED' ? 'Sin factor' : 'Activa'}</p>
                {member.userId === me.userId ? <p>Este es tu usuario.</p> : null}
                {manager && member.userId !== me.userId ? (
                  <MemberActions member={member} assignable={assignable} password={password} code={code} setPassword={setPassword} setCode={setCode} reasonCode={reasonCode} setReasonCode={setReasonCode} onDone={message => { setInfo(message); setPassword(''); setCode(''); setReload(value => value + 1); }} />
                ) : null}
              </article>
            ))}
          </div>}
          {roleState !== 'pending' && membersCursor ? (
            <div className="pager">
              <button type="button" disabled={membersLoading} aria-busy={membersLoading} onClick={() => { if (!membersBusy.current) void loadMembers(membersCursor, listEpoch.current); }}>Cargar más personas</button>
              {membersLoading ? <p role="status">Cargando personas...</p> : null}
            </div>
          ) : null}
          {roleState === 'ready' && manager ? (
            <form className="org-sheet" onSubmit={onSubmit(async () => {
              const command = { email, roleIds: roles };
              await reauthenticate({ password, purpose: 'MEMBER_INVITE', resourceId: me.organizationId, command, code });
              await call('POST', '/organization/invitations', command);
              setEmail(''); setPassword(''); setCode('');
              setInfo('Invitación aceptada para envío. Prepararla no afilia a la persona.');
              setReload(value => value + 1);
            }, setPending, setError)}>
              <h2>Invitar</h2>
              <p>No se puede asignar titular ni superadmin. El servidor aplica la jerarquía.</p>
              <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" required /></Field>
              <RolePicker roles={roles} setRoles={setRoles} assignable={assignable} />
              <StepFields legend="Confirmar invitación" password={password} code={code} setPassword={setPassword} setCode={setCode} />
              <Submit pending={pending}>Enviar invitación</Submit>
            </form>
          ) : null}
          {roleState === 'pending' ? null : <h2>Invitaciones</h2>}
          {roleState !== 'pending' && invitationsError ? <ErrorText error={invitationsError} /> : null}
          {roleState !== 'pending' && invitationsLoading && invitations.length === 0 ? <p role="status">Cargando invitaciones...</p> : null}
          {roleState === 'pending' || (membersLoading && members.length === 0) ? null : (
            <div className="org-people">
              {invitations.map(invitation => (
                <article className="org-member" key={invitation.id}>
                  <h3>{invitation.email}</h3>
                  <p>{invitation.status} · vence {new Date(invitation.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
                  {manager && invitation.status === 'PENDING' ? <button type="button" onClick={() => void revokeInvitation(invitation).catch(setError)}>Revocar invitación</button> : null}
                </article>
              ))}
            </div>
          )}
          {roleState !== 'pending' && invitationsCursor && !(membersLoading && members.length === 0) ? (
            <div className="pager">
              <button type="button" disabled={invitationsLoading} aria-busy={invitationsLoading} onClick={() => { if (!invitationsBusy.current) void loadInvitations(invitationsCursor, listEpoch.current); }}>Cargar más invitaciones</button>
              {invitationsLoading ? <p role="status">Cargando invitaciones...</p> : null}
            </div>
          ) : null}
          {actorRoleIds?.includes('T') && organization?.version ? (
            <form className="org-sheet" onSubmit={onSubmit(async () => {
              await reauthenticate({ password, purpose: 'ORGANIZATION_SESSIONS_REVOKE', resourceId: organization.id, code });
              const result = await call<{ revokedCount: number }>('POST', '/organization/sessions/revoke-all', { reasonCode }, { ifMatch: organization.version });
              setInfo(`Sesiones operativas cerradas: ${result.data.revokedCount}. El recuento no incluye pre-sesiones.`);
              await refresh();
              setReload(value => value + 1);
            }, setPending, setError)}>
              <h2>Cerrar sesiones de la organización</h2>
              <Reason value={reasonCode} setValue={setReasonCode} />
              <StepFields legend="Confirmar cierre de la organización" password={password} code={code} setPassword={setPassword} setCode={setCode} />
              <Submit pending={pending}>Cerrar sesiones operativas</Submit>
            </form>
          ) : null}
        </section>
      ) : null}
      </div>
    </Panel>
  );

  async function loadMembers(cursor: string | null, epoch: number) {
    if (membersBusy.current) return;
    membersBusy.current = true;
    setMembersLoading(true);
    try {
      const result = await call<Page<Member>>('GET', `/organization/members${pageQuery(cursor)}`);
      if (epoch !== listEpoch.current) return;
      setMembers(current => mergePage(current, result.data.items, cursor, item => item.userId));
      setMembersCursor(nextCursor(result.data.nextCursor));
      setMembersError(null);
    } catch (reason) {
      if (epoch === listEpoch.current) setMembersError(reason);
    } finally {
      if (epoch === listEpoch.current) {
        membersBusy.current = false;
        setMembersLoading(false);
      }
    }
  }

  async function loadInvitations(cursor: string | null, epoch: number) {
    if (invitationsBusy.current) return;
    invitationsBusy.current = true;
    setInvitationsLoading(true);
    try {
      const result = await call<Page<Invitation>>('GET', `/organization/invitations${pageQuery(cursor)}`);
      if (epoch !== listEpoch.current) return;
      setInvitations(current => mergePage(current, result.data.items, cursor, item => item.id));
      setInvitationsCursor(nextCursor(result.data.nextCursor));
      setInvitationsError(null);
    } catch (reason) {
      if (epoch === listEpoch.current) setInvitationsError(reason);
    } finally {
      if (epoch === listEpoch.current) {
        invitationsBusy.current = false;
        setInvitationsLoading(false);
      }
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    await reauthenticate({ password, purpose: 'INVITATION_REVOKE', resourceId: invitation.id, code });
    await call('DELETE', `/organization/invitations/${invitation.id}`, undefined, { ifMatch: invitation.version });
    setInfo('Invitación revocada.');
    setPassword('');
    setCode('');
    setReload(value => value + 1);
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
