import { useEffect, useRef, useState } from 'react';
import { OpeningWizard } from '../opening/Opening';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { accountCreateError, isStrong } from '../../shared/contracts';
import { AccountPicker } from './account-picker';
import { bindCommand, cents, formatCop, fromCents, parseLocalCop, releaseCommand, todayBogota, type CommandBinding } from '../../shared/money';
import { Alert, Empty, ErrorText, Field, Panel, StepFields, Submit, onSubmit } from '../../shared/ui';

const CLASSES = [
  ['ASSET', 'Activo'],
  ['LIABILITY', 'Pasivo'],
  ['EQUITY', 'Patrimonio'],
  ['INCOME', 'Ingreso'],
  ['EXPENSE', 'Gasto'],
] as const;
const KINDS = [['CASH', 'Caja'], ['BANK', 'Banco'], ['GENERAL', 'General']] as const;
const SOURCE_LABEL: Record<string, string> = { MANUAL_JOURNAL: 'Asiento manual', TRANSFER: 'Transferencia', REVERSAL: 'Reversión', OPENING: 'Apertura manual' };

interface Account {
  id: string; code: string; name: string; accountClass: string; kind: string; status: string; version: number; currency: string;
}
interface JournalLine { accountId: string; debit: string; credit: string }
interface Journal {
  id: string; effectiveDate: string; recordedAt: string; status: string; description: string; supportReference: string;
  source: { type: string; id: string }; reversalOfId: string | null; lines: JournalLine[]; version: number;
}
interface BalanceItem { accountId: string; naturalBalance: string; debitTotal: string; creditTotal: string }
interface Page<T> { items: T[]; nextCursor: string | null }
interface BalanceBook { asOf: string; recordedThrough: string; items: BalanceItem[] }
interface DraftLine { accountId: string; side: 'debit' | 'credit'; amount: string }

function label(options: readonly (readonly [string, string])[], value: string): string {
  return options.find(item => item[0] === value)?.[1] ?? value;
}

function text(value: string): string {
  return value.trim().normalize('NFC');
}

export function FinanceScreen() {
  const { me, phase } = useAuth();
  const [access, setAccess] = useState<'loading' | 'closed' | 'ready'>('loading');
  const [accessError, setAccessError] = useState<unknown>(null);
  const organizationId = me?.organizationId ?? '';
  const titular = access === 'ready';
  useEffect(() => {
    if (!isStrong(me) || !organizationId) return;
    let cancel = false;
    setAccess('loading');
    void call<{ status?: string; actorRoleIds?: unknown }>('GET', '/organization').then(result => {
      if (cancel) return;
      const roles = Array.isArray(result.data.actorRoleIds) ? result.data.actorRoleIds.filter((role): role is string => typeof role === 'string') : [];
      setAccess(result.data.status === 'ACTIVE' && roles.includes('T') && !roles.includes('SA') ? 'ready' : 'closed');
    }).catch(error => { if (!cancel) { setAccessError(error); setAccess('closed'); } });
    return () => { cancel = true; };
  }, [me, organizationId]);
  if (!isStrong(me)) {
    return <Panel title="Finanzas" id="page-title"><p>El libro se abre con una sesión comprobada. <a href="#/perfil">Ir al perfil</a></p></Panel>;
  }
  if (!organizationId) {
    return <Panel title="Finanzas" id="page-title"><p>Todavía no hay organización. <a href="#/organizacion">Crear o abrir la organización</a></p></Panel>;
  }
  return (
    <Panel title="Finanzas" id="page-title">
      {phase === 'loading' || access === 'loading' ? <p role="status">Cargando el libro…</p> : null}
      <ErrorText error={accessError} />
      <p>Libro de negocio de esta organización, en pesos colombianos. El servidor calcula el saldo; esta pantalla solo lo muestra.</p>
      {access === 'closed' ? <Alert tone="pending">El libro solo está disponible para el titular de una organización activa. No hay controles de cuentas, asientos, transferencias ni reversión.</Alert> : null}
      {titular ? <Book organizationId={organizationId} /> : null}
    </Panel>
  );
}

function Book({ organizationId }: { organizationId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountCursor, setAccountCursor] = useState<string | null>(null);
  const [accountPage, setAccountPage] = useState<string | null>(null);
  const [accountBack, setAccountBack] = useState<(string | null)[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [journalCursor, setJournalCursor] = useState<string | null>(null);
  const [journalPage, setJournalPage] = useState<string | null>(null);
  const [journalBack, setJournalBack] = useState<(string | null)[]>([]);
  const [listError, setListError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const base = `/organizations/${organizationId}/financial`;
  const names = new Map(accounts.map(account => [account.id, `${account.code} · ${account.name}`]));
  async function loadAccounts(cursor: string | null) {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const result = await call<Page<Account>>('GET', `${base}/accounts?${query.toString()}`);
    setAccounts(result.data.items);
    setAccountCursor(result.data.nextCursor);
  }
  async function loadJournals(cursor: string | null) {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    else query.set('asOf', todayBogota());
    const result = await call<Page<Journal>>('GET', `${base}/journal-entries?${query.toString()}`);
    setJournals(result.data.items);
    setJournalCursor(result.data.nextCursor);
  }
  async function reload() {
    setLoading(true); setListError(null);
    try {
      await Promise.all([loadAccounts(null), loadJournals(null)]);
      setAccountPage(null); setJournalPage(null); setAccountBack([]); setJournalBack([]);
    } catch (error) { setListError(error); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, [organizationId]);
  return (
    <div className="stack">
      {loading ? <p role="status">Cargando cuentas y asientos…</p> : null}
      <ErrorText error={listError} />
      <AccountCatalog accounts={accounts} organizationId={organizationId} base={base} cursor={accountCursor} hasPrevious={accountBack.length > 0} onNext={async () => {
        if (!accountCursor) return;
        setListError(null); setAccountBack(current => [...current, accountPage]); setAccountPage(accountCursor); await loadAccounts(accountCursor);
      }} onPrevious={async () => {
        const previous = accountBack.at(-1) ?? null;
        setListError(null); setAccountBack(current => current.slice(0, -1)); setAccountPage(previous); await loadAccounts(previous);
      }} onChanged={reload} />
      <BalanceQuery base={base} names={names} />
      <JournalForm organizationId={organizationId} base={base} onPosted={reload} />
      <TransferForm organizationId={organizationId} base={base} onPosted={reload} />
      <OpeningWizard organizationId={organizationId} base={base} />
      <JournalList journals={journals} names={names} organizationId={organizationId} base={base} cursor={journalCursor} hasPrevious={journalBack.length > 0} onNext={async () => {
        if (!journalCursor) return;
        setListError(null); setJournalBack(current => [...current, journalPage]); setJournalPage(journalCursor); await loadJournals(journalCursor);
      }} onPrevious={async () => {
        const previous = journalBack.at(-1) ?? null;
        setListError(null); setJournalBack(current => current.slice(0, -1)); setJournalPage(previous); await loadJournals(previous);
      }} onChanged={reload} />
    </div>
  );
}

function AccountCatalog({ accounts, organizationId, base, cursor, hasPrevious, onNext, onPrevious, onChanged }: {
  accounts: Account[]; organizationId: string; base: string; cursor: string | null; hasPrevious: boolean;
  onNext: () => Promise<void>; onPrevious: () => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accountClass, setAccountClass] = useState<(typeof CLASSES)[number][0]>('ASSET');
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('BANK');
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rename, setRename] = useState<{ id: string; name: string; etag: string } | null>(null);
  const [renamePassword, setRenamePassword] = useState('');
  const [renameCode, setRenameCode] = useState('');
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<unknown>(null);
  const scope = useRef<CommandBinding | null>(null);
  const renameScope = useRef<CommandBinding | null>(null);
  const restricted = kind === 'CASH' || kind === 'BANK';
  const selectedClass = restricted ? 'ASSET' : accountClass;
  return (
    <section className="card" aria-labelledby="cuentas-titulo">
      <h2 id="cuentas-titulo">Cuentas</h2>
      <p className="muted">No se edita el saldo, la clase, el tipo ni la moneda. El alta queda activa.</p>
      {accounts.length === 0 ? <Empty>No hay cuentas en esta página.</Empty> : (
        <div className="cards">
          {accounts.map(account => (
            <article key={account.id} className="card">
              <h3>{account.code} · {account.name}</h3>
              <p>{label(CLASSES, account.accountClass)} · {label(KINDS, account.kind)} · {account.status === 'ACTIVE' ? 'Activa' : account.status} · COP</p>
              <p className="muted">Versión {account.version}. El saldo no está en esta ficha.</p>
              <button type="button" onClick={() => {
                setRenameError(null);
                void call<Account>('GET', `${base}/accounts/${account.id}`).then(result => {
                  if (!result.etag) { setRenameError(new Error('La consulta no devolvió la versión necesaria.')); return; }
                  setRename({ id: account.id, name: account.name, etag: result.etag });
                }).catch(setRenameError);
              }}>Cambiar nombre</button>
            </article>
          ))}
        </div>
      )}
      <div className="pager">
        <button type="button" disabled={!hasPrevious} onClick={() => void onPrevious().catch(setError)}>Cuentas anteriores</button>
        <button type="button" disabled={!cursor} onClick={() => void onNext().catch(setError)}>Cuentas siguientes</button>
      </div>
      {rename ? (
        <form onSubmit={onSubmit(async () => {
          const payload = { name: text(rename.name) };
          const command = { organizationId, idempotencyKey: bindCommand(renameScope, JSON.stringify(['rename', rename.id, rename.etag, payload])).idempotencyKey, expectedETag: rename.etag, payload };
          await reauthenticate({ password: renamePassword, purpose: 'FINANCE_ACCOUNT_UPDATE', resourceId: rename.id, command, code: renameCode });
          await call('PATCH', `${base}/accounts/${rename.id}`, payload, { ifMatch: rename.etag, idempotencyKey: command.idempotencyKey });
          releaseCommand(renameScope); setRenamePassword(''); setRenameCode(''); setRename(null); await onChanged();
        }, setRenamePending, setRenameError)}>
          <ErrorText error={renameError} />
          <Field label="Nuevo nombre"><input value={rename.name} onChange={event => setRename({ ...rename, name: event.target.value })} minLength={1} maxLength={100} required /></Field>
          <StepFields legend="Confirmar el cambio de nombre" password={renamePassword} code={renameCode} setPassword={setRenamePassword} setCode={setRenameCode} />
          <Submit pending={renamePending}>Guardar nombre</Submit>
        </form>
      ) : null}
      <form onSubmit={onSubmit(async () => {
        const payload = { code: code.trim().toUpperCase(), name: text(name), accountClass: selectedClass, kind, currency: 'COP' as const };
        const binding = bindCommand(scope, JSON.stringify(['create', payload]));
        const command = { organizationId, idempotencyKey: binding.idempotencyKey, payload };
        await reauthenticate({ password, purpose: 'FINANCE_ACCOUNT_CREATE', command, code: stepCode });
        try {
          await call('POST', `${base}/accounts`, payload, { idempotencyKey: binding.idempotencyKey });
        } catch (caught) {
          throw accountCreateError(caught);
        }
        releaseCommand(scope); setPassword(''); setStepCode(''); setCode(''); setName(''); await onChanged();
      }, setPending, setError)}>
        <h3>Nueva cuenta</h3>
        <ErrorText error={error} />
        <Field label="Código" hint="Letras mayúsculas, números o guion bajo. Sin espacios."><input value={code} onChange={event => setCode(event.target.value.toUpperCase())} pattern="[A-Z0-9_]{1,32}" maxLength={32} required /></Field>
        <Field label="Nombre"><input value={name} onChange={event => setName(event.target.value)} minLength={1} maxLength={100} required /></Field>
        <Field label="Clase"><select value={selectedClass} onChange={event => setAccountClass(event.target.value as typeof accountClass)} disabled={restricted}>{CLASSES.map(([value, caption]) => <option key={value} value={value}>{caption}</option>)}</select></Field>
        <Field label="Tipo"><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{KINDS.map(([value, caption]) => <option key={value} value={value}>{caption}</option>)}</select></Field>
        <p className="muted">Moneda fija: COP. Caja y banco solo pueden ser activo.</p>
        <StepFields legend="Confirmar la nueva cuenta" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
        <Submit pending={pending}>Crear cuenta contable</Submit>
      </form>
    </section>
  );
}

function BalanceQuery({ base, names }: { base: string; names: Map<string, string> }) {
  const [asOf, setAsOf] = useState(todayBogota());
  const [book, setBook] = useState<BalanceBook | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="card" aria-labelledby="saldo-titulo">
      <h2 id="saldo-titulo">Saldo por fecha</h2>
      <p>La cifra sale del libro confirmado hasta la fecha económica, inclusive. No mezcla pendientes ni simulaciones.</p>
      <form onSubmit={onSubmit(async () => {
        const result = await call<BalanceBook>('GET', `${base}/balances?asOf=${asOf}`);
        setBook(result.data);
      }, setPending, setError)}>
        <ErrorText error={error} />
        <Field label="Fecha de corte"><input type="date" value={asOf} max={todayBogota()} onChange={event => setAsOf(event.target.value)} required /></Field>
        <Submit pending={pending}>Consultar saldo</Submit>
      </form>
      {book ? (
        <>
          <p>Corte económico {book.asOf}. Registrado hasta {new Date(book.recordedThrough).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.</p>
          {book.items.length === 0 ? <Empty>No hay cuentas para ese corte.</Empty> : (
            <div className="cards">
              {book.items.map(item => (
                <p key={item.accountId}><strong>{names.get(item.accountId) ?? item.accountId}</strong>: {formatCop(item.naturalBalance) ?? item.naturalBalance} COP <span className="muted">saldo del libro</span></p>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function JournalForm({ organizationId, base, onPosted }: { organizationId: string; base: string; onPosted: () => Promise<void> }) {
  const [effectiveDate, setEffectiveDate] = useState(todayBogota());
  const [supportReference, setSupportReference] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ accountId: '', side: 'debit', amount: '' }, { accountId: '', side: 'credit', amount: '' }]);
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const scope = useRef<CommandBinding | null>(null);
  const parsed = lines.map(line => parseLocalCop(line.amount));
  const debit = parsed.reduce<bigint>((sum, amount, index) => sum + (lines[index]?.side === 'debit' && amount ? cents(amount) ?? 0n : 0n), 0n);
  const credit = parsed.reduce<bigint>((sum, amount, index) => sum + (lines[index]?.side === 'credit' && amount ? cents(amount) ?? 0n : 0n), 0n);
  return (
    <section className="card" aria-labelledby="asiento-titulo">
      <h2 id="asiento-titulo">Asiento</h2>
      <form onSubmit={onSubmit(async () => {
        setFormError(null);
        if (parsed.some(amount => !amount || amount === '0.00') || lines.some(line => !line.accountId)) { setFormError('Cada línea necesita una cuenta y un importe mayor que cero, con punto de miles y coma decimal.'); return; }
        if (new Set(lines.map(line => line.accountId)).size < 2) { setFormError('El asiento usa al menos dos cuentas distintas.'); return; }
        if (debit !== credit) { setFormError('La comprobación del formulario no cuadra. No se envió y no es el saldo del libro.'); return; }
        const payload = {
          currency: 'COP' as const, effectiveDate, sourceId: '', supportReference: text(supportReference), description: text(description),
          lines: lines.map((line, index) => ({ accountId: line.accountId, debit: line.side === 'debit' ? parsed[index]! : '0.00', credit: line.side === 'credit' ? parsed[index]! : '0.00' })),
        };
        const binding = bindCommand(scope, JSON.stringify({ ...payload, sourceId: undefined }));
        payload.sourceId = binding.sourceId;
        const command = { organizationId, idempotencyKey: binding.idempotencyKey, payload };
        await reauthenticate({ password, purpose: 'FINANCE_JOURNAL_POST', command, code: stepCode });
        await call('POST', `${base}/journal-entries`, payload, { idempotencyKey: binding.idempotencyKey });
        releaseCommand(scope); setPassword(''); setStepCode(''); setSupportReference(''); setDescription(''); await onPosted();
      }, setPending, setError)}>
        <ErrorText error={error} />
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Fecha económica"><input type="date" value={effectiveDate} max={todayBogota()} onChange={event => setEffectiveDate(event.target.value)} required /></Field>
        <Field label="Soporte"><input value={supportReference} onChange={event => setSupportReference(event.target.value)} minLength={1} maxLength={200} required /></Field>
        <Field label="Descripción"><input value={description} onChange={event => setDescription(event.target.value)} minLength={1} maxLength={200} required /></Field>
        {lines.map((line, index) => (
          <fieldset key={index} className="split">
            <legend>Línea {index + 1}</legend>
            <AccountPicker base={base} label={`línea ${index + 1}`} value={line.accountId} onChange={accountId => setLines(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, accountId } : item))} />
            <Field label="Lado"><select value={line.side} onChange={event => setLines(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, side: event.target.value as DraftLine['side'] } : item))}><option value="debit">Débito</option><option value="credit">Crédito</option></select></Field>
            <Field label="Importe" hint="Ejemplo: 1.999 o 1.999,50. La coma separa los centavos."><input value={line.amount} onChange={event => setLines(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} inputMode="decimal" autoComplete="off" required /></Field>
            <p className="muted">{parsed[index] ? `Se enviará ${parsed[index]} COP.` : 'El importe todavía no tiene el formato del contrato.'}</p>
          </fieldset>
        ))}
        <div className="pager">
          <button type="button" disabled={lines.length >= 100} onClick={() => setLines(current => [...current, { accountId: '', side: 'debit', amount: '' }])}>Agregar línea</button>
          <button type="button" disabled={lines.length <= 2} onClick={() => setLines(current => current.slice(0, -1))}>Quitar línea</button>
        </div>
        <p className="muted">Comprobación del formulario, no es el saldo del libro: débito {formatCop(fromCents(debit))} · crédito {formatCop(fromCents(credit))}.</p>
        <StepFields legend="Confirmar el asiento" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
        <Submit pending={pending}>Contabilizar asiento</Submit>
      </form>
    </section>
  );
}

function TransferForm({ organizationId, base, onPosted }: { organizationId: string; base: string; onPosted: () => Promise<void> }) {
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(todayBogota());
  const [supportReference, setSupportReference] = useState('');
  const [description, setDescription] = useState('');
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const scope = useRef<CommandBinding | null>(null);
  const canonical = parseLocalCop(amount);
  return (
    <section className="card" aria-labelledby="transferencia-titulo">
      <h2 id="transferencia-titulo">Transferencia</h2>
      <p className="muted">Mueve saldo entre caja y banco. No crea un ingreso ni un gasto.</p>
      <form onSubmit={onSubmit(async () => {
        setFormError(null);
        if (!canonical || canonical === '0.00' || fromAccountId === toAccountId) { setFormError('Elige dos cuentas distintas y un importe mayor que cero.'); return; }
        const payload = { currency: 'COP' as const, effectiveDate, sourceId: '', supportReference: text(supportReference), description: text(description), fromAccountId, toAccountId, amount: canonical };
        const binding = bindCommand(scope, JSON.stringify({ ...payload, sourceId: undefined, amount: canonical }));
        payload.sourceId = binding.sourceId;
        const command = { organizationId, idempotencyKey: binding.idempotencyKey, payload };
        await reauthenticate({ password, purpose: 'FINANCE_TRANSFER', command, code: stepCode });
        await call('POST', `${base}/transfers`, payload, { idempotencyKey: binding.idempotencyKey });
        releaseCommand(scope); setPassword(''); setStepCode(''); setAmount(''); await onPosted();
      }, setPending, setError)}>
        <ErrorText error={error} />
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <AccountPicker base={base} label="origen" value={fromAccountId} kinds={['CASH', 'BANK']} onChange={setFromAccountId} />
        <AccountPicker base={base} label="destino" value={toAccountId} kinds={['CASH', 'BANK']} onChange={setToAccountId} />
        <Field label="Importe" hint="Ejemplo: 25,50. Se envía con dos decimales y sin separador de miles."><input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" required /></Field>
        <p className="muted">{canonical ? `Se enviará ${canonical} COP.` : 'El importe todavía no tiene el formato del contrato.'}</p>
        <Field label="Fecha económica"><input type="date" value={effectiveDate} max={todayBogota()} onChange={event => setEffectiveDate(event.target.value)} required /></Field>
        <Field label="Soporte"><input value={supportReference} onChange={event => setSupportReference(event.target.value)} required /></Field>
        <Field label="Descripción"><input value={description} onChange={event => setDescription(event.target.value)} required /></Field>
        <StepFields legend="Confirmar la transferencia" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
        <Submit pending={pending}>Transferir</Submit>
      </form>
    </section>
  );
}

function JournalList({ journals, names, organizationId, base, cursor, hasPrevious, onNext, onPrevious, onChanged }: {
  journals: Journal[]; names: Map<string, string>; organizationId: string; base: string; cursor: string | null; hasPrevious: boolean;
  onNext: () => Promise<void>; onPrevious: () => Promise<void>; onChanged: () => Promise<void>;
}) {
  const reversed = new Set(journals.flatMap(journal => journal.reversalOfId ? [journal.reversalOfId] : []));
  const [target, setTarget] = useState<{ id: string; etag: string } | null>(null);
  const [reason, setReason] = useState('');
  const [supportReference, setSupportReference] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(todayBogota());
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const scope = useRef<CommandBinding | null>(null);
  return (
    <section className="card" aria-labelledby="movimientos-titulo">
      <h2 id="movimientos-titulo">Movimientos</h2>
      <ErrorText error={error} />
      {journals.length === 0 ? <Empty>No hay asientos hasta hoy en esta página.</Empty> : (
        <div className="cards">
          {journals.map(journal => {
            const reversible = journal.source.type !== 'REVERSAL' && journal.source.type !== 'OPENING' && !journal.reversalOfId && !reversed.has(journal.id);
            return (
              <article key={journal.id} className="card">
                <h3>{SOURCE_LABEL[journal.source.type] ?? journal.source.type}</h3>
                <p>Fecha económica {journal.effectiveDate}. Registrado {new Date(journal.recordedAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.</p>
                <p>{journal.status === 'POSTED' ? 'Contabilizado' : journal.status}. {journal.description}</p>
                <p className="muted">Soporte {journal.supportReference}. {journal.reversalOfId ? `Compensa el asiento ${journal.reversalOfId}.` : journal.source.type === 'OPENING' ? 'Apertura al corte. No es un desembolso, un recaudo ni una reversión.' : 'No es una compensación.'}</p>
                <ul>{journal.lines.map((line, index) => <li key={`${line.accountId}-${index}`}>{names.get(line.accountId) ?? line.accountId}: débito {formatCop(line.debit) ?? line.debit}, crédito {formatCop(line.credit) ?? line.credit}</li>)}</ul>
                {reversible ? <button type="button" onClick={() => {
                  setError(null);
                  void call<Journal>('GET', `${base}/journal-entries/${journal.id}`).then(result => {
                    if (!result.etag) { setError(new Error('La consulta no devolvió la versión necesaria.')); return; }
                    setTarget({ id: journal.id, etag: result.etag });
                  }).catch(setError);
                }}>Revertir este asiento</button> : null}
              </article>
            );
          })}
        </div>
      )}
      <div className="pager">
        <button type="button" disabled={!hasPrevious} onClick={() => void onPrevious().catch(setError)}>Asientos anteriores</button>
        <button type="button" disabled={!cursor} onClick={() => void onNext().catch(setError)}>Asientos siguientes</button>
      </div>
      {target ? (
        <form onSubmit={onSubmit(async () => {
          const payload = { effectiveDate, sourceId: '', supportReference: text(supportReference), reason: text(reason) };
          const binding = bindCommand(scope, JSON.stringify(['reverse', target.id, target.etag, { ...payload, sourceId: undefined }]));
          payload.sourceId = binding.sourceId;
          const command = { organizationId, idempotencyKey: binding.idempotencyKey, expectedETag: target.etag, payload };
          await reauthenticate({ password, purpose: 'FINANCE_JOURNAL_REVERSE', resourceId: target.id, command, code: stepCode });
          await call('POST', `${base}/journal-entries/${target.id}/reversals`, payload, { ifMatch: target.etag, idempotencyKey: binding.idempotencyKey });
          releaseCommand(scope); setPassword(''); setStepCode(''); setTarget(null); setReason(''); await onChanged();
        }, setPending, setError)}>
          <Field label="Motivo de la reversión"><input value={reason} onChange={event => setReason(event.target.value)} required /></Field>
          <Field label="Soporte de la reversión"><input value={supportReference} onChange={event => setSupportReference(event.target.value)} required /></Field>
          <Field label="Fecha económica de la reversión"><input type="date" value={effectiveDate} max={todayBogota()} onChange={event => setEffectiveDate(event.target.value)} required /></Field>
          <p className="muted">El asiento original permanece. Se crea una compensación y no se reintenta solo.</p>
          <StepFields legend="Confirmar la reversión" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
          <Submit pending={pending}>Crear compensación</Submit>
        </form>
      ) : null}
    </section>
  );
}
