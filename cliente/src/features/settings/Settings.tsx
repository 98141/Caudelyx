import { useEffect, useRef, useState } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { inOrganization } from '../../shared/contracts';
import { bindCommand, releaseCommand, type CommandBinding } from '../../shared/money';
import { ErrorText, Field, Panel, Submit, onSubmit } from '../../shared/ui';

interface FieldDef { key: string; label: string; type: 'TEXT' | 'DATE' | 'BOOLEAN' | 'ENUM'; deprecated: boolean }
interface Schema { schemaVersion: number; fields: FieldDef[] }

export function SettingsScreen() {
  const { me } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const [schema, setSchema] = useState<Schema | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldDef['type']>('TEXT');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const scope = useRef<CommandBinding | null>(null);

  useEffect(() => {
    let live = true; setSchema(null); setTag(null);
    if (!inOrganization(me)) return;
    void call<Schema>('GET', `/organizations/${organizationId}/borrower-field-schemas/current`).then(result => {
      if (!live) return; setSchema(result.data); setTag(result.etag);
    }).catch(error => { if (live) setError(error); });
    return () => { live = false; };
  }, [me?.userId, me?.authState, organizationId, JSON.stringify(me?.roleIds)]);

  async function publish(fields: FieldDef[]) {
    if (!schema || !tag || !reason.trim()) throw new Error('Escribe el motivo y espera la versión del catálogo.');
    const payload = {changeReason: reason.trim(), fields};
    const binding = bindCommand(scope, JSON.stringify(payload));
    const result = await call<Schema>('POST', `/organizations/${organizationId}/borrower-field-schemas`, payload, {ifMatch: tag, idempotencyKey: binding.idempotencyKey});
    setSchema(result.data); setTag(result.etag); releaseCommand(scope);
  }
  if (!inOrganization(me)) return <Panel title="Configuración" id="page-title"><p>Hace falta la organización actual. Esta pantalla no publica campos de otra cuenta.</p></Panel>;
  return (
    <Panel title="Configuración" id="page-title">
      <p>Campos adicionales del catálogo de prestatarios. Publicar no pide código y no cambia los permisos.</p>
      <ErrorText error={error} />
      {schema ? <p>Versión publicada {schema.schemaVersion}. {schema.fields.length === 0 ? 'Todavía no hay campos.' : `${schema.fields.length} campos.`} Los que ya no admiten valores nuevos siguen visibles.</p> : <p role="status">Cargando el catálogo…</p>}
      <ul>{(schema?.fields ?? []).map(field => <li key={field.key}>{field.label}{field.deprecated ? ' (ya no admite valores nuevos)' : <button type="button" disabled={pending || !reason.trim()} onClick={() => { setPending(true); setError(null); void publish(schema!.fields.map(item => item.key === field.key ? {...item, deprecated:true} : item)).catch(setError).finally(() => setPending(false)); }}>Dejar de admitir valores nuevos en {field.label}</button>}</li>)}</ul>
      <form className="capture" onSubmit={onSubmit(async () => {
        if (!schema || !tag) throw new Error('Falta la versión del catálogo.');
        await publish([...schema.fields, {key:keyName.trim(), label:label.trim(), type, deprecated:false}]);
        setKeyName(''); setLabel(''); setReason('');
      }, setPending, setError)}>
        <Field label="Clave del campo"><input value={keyName} maxLength={32} pattern="[a-z][a-z0-9_]{0,31}" required onChange={event => setKeyName(event.target.value)} /></Field>
        <Field label="Nombre del campo"><input value={label} maxLength={80} required onChange={event => setLabel(event.target.value)} /></Field>
        <Field label="Tipo"><select value={type} onChange={event => setType(event.target.value as FieldDef['type'])}><option value="TEXT">Texto</option><option value="DATE">Fecha</option><option value="BOOLEAN">Sí o no</option></select></Field>
        <Field label="Motivo"><input value={reason} maxLength={240} required onChange={event => setReason(event.target.value)} /></Field>
        <Submit pending={pending} disabled={!schema || !tag}>Publicar</Submit>
      </form>
    </Panel>
  );
}
