import { useEffect, useRef, useState } from 'react';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, isStrong } from '../../shared/contracts';
import { borrowerLabel } from '../../shared/labels';
import { bindCommand, releaseCommand, type CommandBinding } from '../../shared/money';
import { Alert, Empty, ErrorText, Field, Panel, StepFields, Submit, onSubmit } from '../../shared/ui';

type Extra = string | boolean;
interface FieldOption { code: string; label: string }
interface FieldDef { key: string; label: string; type: 'TEXT' | 'DATE' | 'BOOLEAN' | 'ENUM'; deprecated: boolean; options?: FieldOption[] }
interface Schema { schemaVersion: number; fields: FieldDef[] }
interface Profile { displayName: string; schemaVersion: number; extras: Record<string, Extra>; document?: { type: string; number: string }; contact?: { email?: string; phone?: string; address?: string } }
interface Candidate { id: string; borrowerCode: string; displayName: string }
interface Borrower {
  id: string; borrowerCode: string; status: 'ACTIVE' | 'INACTIVE'; version: number; profileVersion: number;
  profile: Profile; possibleDuplicate: boolean; duplicateCandidates: Candidate[];
}
interface Page<T> { items: T[]; nextCursor?: string | null }
interface Version { profileVersion: number; profile: Profile; createdAt: string; changeReason?: string }

const blank = { code: '', name: '', docType: '', docNumber: '', email: '', phone: '', address: '', reason: '' };

function command(organizationId: string, key: string, payload: unknown, etag?: string) {
  return { organizationId, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) };
}

export function BorrowersScreen() {
  const { me } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const base = `/organizations/${organizationId}`;
  const [schema, setSchema] = useState<Schema | null>(null);
  const [schemaTag, setSchemaTag] = useState<string | null>(null);
  const [items, setItems] = useState<Borrower[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Borrower | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [form, setForm] = useState(blank);
  const [extras, setExtras] = useState<Record<string, Extra>>({});
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [schemaReason, setSchemaReason] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [newField, setNewField] = useState({ key: '', label: '', type: 'TEXT' as FieldDef['type'] });
  const saveKey = useRef<CommandBinding | null>(null);
  const strong = isStrong(me);

  async function loadSchema() {
    const result = await call<Schema>('GET', `${base}/borrower-field-schemas/current`);
    setSchema(result.data);
    setSchemaTag(result.etag);
  }

  async function loadList(next: string | null) {
    const params = new URLSearchParams({ limit: '20' });
    if (next) params.set('cursor', next);
    if (status === 'ACTIVE' || status === 'INACTIVE') params.set('status', status);
    if (query.trim()) params.set('q', query.trim());
    setLoading(true);
    try {
      const result = await call<Page<Borrower>>('GET', `${base}/borrowers?${params.toString()}`);
      setItems(result.data.items);
      setCursor(result.data.nextCursor ?? null);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!strong || !organizationId) return;
    setError(null);
    void loadSchema().catch(setError);
    void loadList(null).catch(setError);
  }, [strong, organizationId, status]);

  function profileBody(): Profile {
    if (!schema) throw new ApiError(422, 'INPUT_INVALID', null, 'Carga el catálogo antes de guardar la ficha.');
    const profile: Profile = { displayName: form.name.trim(), schemaVersion: schema.schemaVersion, extras: {} };
    for (const field of schema?.fields ?? []) {
      if (field.deprecated) continue;
      const value = extras[field.key];
      if (value === undefined || value === '') continue;
      profile.extras[field.key] = value;
    }
    if (form.docType && form.docNumber.trim()) profile.document = { type: form.docType, number: form.docNumber.trim() };
    const contact = { ...(form.email.trim() ? { email: form.email.trim() } : {}), ...(form.phone.trim() ? { phone: form.phone.trim() } : {}), ...(form.address.trim() ? { address: form.address.trim() } : {}) };
    if (Object.keys(contact).length) profile.contact = contact;
    return profile;
  }

  async function loadVersions(id: string, next?: string) {
    const result = await call<Page<Version>>('GET', `${base}/borrowers/${id}/versions?limit=20${next ? '&cursor=' + encodeURIComponent(next) : ''}`);
    setVersions(result.data.items); setVersionCursor(result.data.nextCursor ?? null);
  }

  async function openBorrower(id: string) {
    setPending(true); setVersions([]); setVersionCursor(null); setError(null);
    try {
    const result = await call<Borrower>('GET', `${base}/borrowers/${id}`);
    setSelected(result.data);
    setEtag(result.etag);
    setForm({ ...blank, name: result.data.profile.displayName, docType: result.data.profile.document?.type ?? '', docNumber: result.data.profile.document?.number ?? '', email: result.data.profile.contact?.email ?? '', phone: result.data.profile.contact?.phone ?? '', address: result.data.profile.contact?.address ?? '' });
    setExtras(result.data.profile.extras);
    await loadVersions(id);
    } finally { setPending(false); }
  }

  async function prove(purpose: string, payload: unknown, resourceId?: string, match?: string) {
    const binding = bindCommand(saveKey, JSON.stringify([purpose, resourceId ?? '', match ?? '', payload]));
    const body = command(organizationId, binding.idempotencyKey, payload, match);
    await reauthenticate({ password, purpose, ...(resourceId ? { resourceId } : {}), command: body, code: stepCode });
    setPassword(''); setStepCode('');
    return binding.idempotencyKey;
  }

  if (!strong || !organizationId) return <Panel title="Prestatarios" id="page-title"><p>Hace falta una sesión de la organización. Esta pantalla no consulta datos de negocio.</p></Panel>;

  return (
    <Panel title="Prestatarios" id="page-title">
      <p>Los datos de esta pantalla son de la organización actual. Un nombre parecido solo avisa; no fusiona fichas ni consulta otras organizaciones.</p>
      <ErrorText error={error} />
      <form onSubmit={event => { event.preventDefault(); void loadList(null).catch(setError); }}>
        <Field label="Buscar por código o nombre"><input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></Field>
        <Field label="Estado">
          <select value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">Todos</option>
            <option value="ACTIVE">Activo</option>
            <option value="INACTIVE">Inactivo</option>
          </select>
        </Field>
        <Submit pending={loading}>Buscar</Submit>
      </form>
      {loading ? <p role="status">Cargando prestatarios…</p> : null}
      {!loading && items.length === 0 ? <Empty>No hay prestatarios con ese criterio.</Empty> : (
        <ul>{items.map(item => (
          <li key={item.id}><button type="button" disabled={pending} onClick={() => void openBorrower(item.id).catch(setError)}>{borrowerLabel(item.borrowerCode, item.profile.displayName)}</button> {item.status === 'ACTIVE' ? 'Activo' : 'Inactivo'}</li>
        ))}</ul>
      )}
      {cursor ? <button type="button" onClick={() => void loadList(cursor).catch(setError)}>Página siguiente</button> : null}

      <button type="button" disabled={pending} onClick={() => { setSelected(null); setEtag(null); setForm(blank); setExtras({}); setVersions([]); setVersionCursor(null); setPassword(''); setStepCode(''); releaseCommand(saveKey); }}>Nueva ficha</button>
      <h2>{selected ? borrowerLabel(selected.borrowerCode, selected.profile.displayName) : 'Nueva ficha'}</h2>
      {selected?.possibleDuplicate ? <Alert tone="pending">Hay otro prestatario de esta organización con un nombre parecido. No se fusionaron. {selected.duplicateCandidates.map(item => borrowerLabel(item.borrowerCode, item.displayName)).join('; ')}</Alert> : null}
      <form onSubmit={onSubmit(async () => {
        const profile = profileBody();
        if (selected) {
          const payload = { profile, changeReason: form.reason.trim() };
          const key = await prove('BORROWER_REPLACE', payload, selected.id, etag ?? undefined);
          const result = await call<Borrower>('PUT', `${base}/borrowers/${selected.id}`, payload, { ifMatch: etag ?? undefined, idempotencyKey: key });
          setSelected(result.data); setEtag(result.etag); releaseCommand(saveKey);
          await loadVersions(result.data.id);
        } else {
          const payload = { borrowerCode: form.code.trim().toUpperCase(), profile };
          const key = await prove('BORROWER_CREATE', payload);
          const result = await call<Borrower>('POST', `${base}/borrowers`, payload, { idempotencyKey: key });
          setSelected(result.data); setEtag(result.etag); releaseCommand(saveKey);
          await loadVersions(result.data.id);
        }
        await loadList(null);
      }, setPending, setError)}>
        <fieldset disabled={pending}>
        <legend>Datos de la ficha</legend>
        {selected ? <p>Código {selected.borrowerCode}. Versión de ficha {selected.profileVersion}. El código no se cambia.</p> : (
          <Field label="Código"><input value={form.code} maxLength={40} required pattern="[A-Za-z0-9_-]{1,40}" onChange={event => setForm(current => ({ ...current, code: event.target.value.toUpperCase() }))} /></Field>
        )}
        <Field label="Nombre"><input value={form.name} maxLength={120} required onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="Tipo de documento">
          <select value={form.docType} onChange={event => setForm(current => ({ ...current, docType: event.target.value }))}>
            <option value="">Sin documento</option>
            <option value="CC">Cédula</option>
            <option value="CE">Cédula de extranjería</option>
            <option value="NIT">NIT</option>
            <option value="PASSPORT">Pasaporte</option>
            <option value="OTHER">Otro</option>
          </select>
        </Field>
        <Field label="Número de documento"><input value={form.docNumber} maxLength={80} onChange={event => setForm(current => ({ ...current, docNumber: event.target.value }))} /></Field>
        <Field label="Correo de contacto"><input value={form.email} type="email" maxLength={254} onChange={event => setForm(current => ({ ...current, email: event.target.value }))} /></Field>
        <Field label="Teléfono"><input value={form.phone} maxLength={40} onChange={event => setForm(current => ({ ...current, phone: event.target.value }))} /></Field>
        <Field label="Dirección"><input value={form.address} maxLength={160} onChange={event => setForm(current => ({ ...current, address: event.target.value }))} /></Field>
        {(schema?.fields ?? []).map(field => field.deprecated ? <p key={field.key}>{field.label}: valor anterior, no se vuelve a enviar.</p> : (
          <Field key={field.key} label={field.label}>
            {field.type === 'BOOLEAN' ? <input type="checkbox" checked={extras[field.key] === true} onChange={event => setExtras(current => ({ ...current, [field.key]: event.target.checked }))} /> : null}
            {field.type === 'ENUM' ? (
              <select value={typeof extras[field.key] === 'string' ? String(extras[field.key]) : ''} onChange={event => setExtras(current => ({ ...current, [field.key]: event.target.value }))}>
                <option value="">Sin valor</option>
                {(field.options ?? []).map(option => <option key={option.code} value={option.code}>{option.label}</option>)}
              </select>
            ) : null}
            {field.type === 'TEXT' || field.type === 'DATE' ? <input type={field.type === 'DATE' ? 'date' : 'text'} maxLength={240} value={typeof extras[field.key] === 'string' ? String(extras[field.key]) : ''} onChange={event => setExtras(current => ({ ...current, [field.key]: event.target.value }))} /> : null}
          </Field>
        ))}
        {selected ? <Field label="Motivo del cambio"><input value={form.reason} maxLength={240} required onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} /></Field> : null}
        <StepFields legend="Confirmar el guardado de la ficha" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
        <Submit pending={pending} disabled={!schema}>{selected ? 'Guardar cambios' : 'Crear ficha'}</Submit>
        </fieldset>
      </form>
      {selected ? (
        <form onSubmit={onSubmit(async () => {
          const purpose = selected.status === 'ACTIVE' ? 'BORROWER_DEACTIVATE' : 'BORROWER_REACTIVATE';
          const path = selected.status === 'ACTIVE' ? 'deactivation' : 'reactivation';
          const payload = { reason: form.reason.trim() };
          const key = await prove(purpose, payload, selected.id, etag ?? undefined);
          const result = await call<Borrower>('POST', `${base}/borrowers/${selected.id}/${path}`, payload, { ifMatch: etag ?? undefined, idempotencyKey: key });
          setSelected(result.data); setEtag(result.etag); releaseCommand(saveKey);
          await loadVersions(result.data.id);
          await loadList(null);
        }, setPending, setError)}>
          <Submit pending={pending}>{selected.status === 'ACTIVE' ? 'Desactivar ficha' : 'Reactivar ficha'}</Submit>
        </form>
      ) : null}
      {versions.length ? (
        <section>
          <h2>Versiones de la ficha</h2>
          {versionCursor && selected ? <button type="button" onClick={() => void loadVersions(selected.id, versionCursor).catch(setError)}>Más versiones de la ficha</button> : null}
          <ul>{versions.map(item => <li key={item.profileVersion}>Versión {item.profileVersion}: {item.profile.displayName}. {item.changeReason ?? 'Alta inicial'}.</li>)}</ul>
        </section>
      ) : null}
      <section>
        <h2>Campos adicionales</h2>
        {schema && schema.fields.length === 0 ? <p>El catálogo de esta organización no tiene campos adicionales. La versión actual es {schema.schemaVersion}.</p> : (
          <ul>{(schema?.fields ?? []).map(field => <li key={field.key}>{field.label}{field.deprecated ? ' (ya no admite valores nuevos)' : ''}</li>)}</ul>
        )}
        <form onSubmit={onSubmit(async () => {
          if (!schema || !schemaTag) throw new Error('Falta la versión del catálogo.');
          const payload = { changeReason: schemaReason.trim(), fields: [...schema.fields, { key: newField.key.trim(), label: newField.label.trim(), type: newField.type, deprecated: false }] };
          const key = await prove('BORROWER_SCHEMA_PUBLISH', payload, undefined, schemaTag);
          const result = await call<Schema>('POST', `${base}/borrower-field-schemas`, payload, { ifMatch: schemaTag, idempotencyKey: key });
          setSchema(result.data); setSchemaTag(result.etag); releaseCommand(saveKey); setNewField({ key: '', label: '', type: 'TEXT' });
        }, setPending, setError)}>
          <Field label="Clave del campo"><input value={newField.key} maxLength={32} pattern="[a-z][a-z0-9_]{0,31}" required onChange={event => setNewField(current => ({ ...current, key: event.target.value }))} /></Field>
          <Field label="Nombre del campo"><input value={newField.label} maxLength={80} required onChange={event => setNewField(current => ({ ...current, label: event.target.value }))} /></Field>
          <Field label="Tipo"><select value={newField.type} onChange={event => setNewField(current => ({ ...current, type: event.target.value as FieldDef['type'] }))}><option value="TEXT">Texto</option><option value="DATE">Fecha</option><option value="BOOLEAN">Sí o no</option></select></Field>
          <Field label="Motivo del cambio de catálogo"><input value={schemaReason} maxLength={240} required onChange={event => setSchemaReason(event.target.value)} /></Field>
          <StepFields legend="Publicar el campo" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
          <Submit pending={pending} disabled={!schema || !schemaTag}>Publicar campo</Submit>
        </form>
      </section>
    </Panel>
  );
}
