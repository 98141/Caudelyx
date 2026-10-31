/* eslint-disable security/detect-object-injection -- Closed template/operation paths, typed alias resolution and no executable JSON. */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { dictionary, exchangeContract } from './contract.js';
import { workbookIdentity, canonical, jsonText } from './canonical.js';
import { cents, money } from '../finance/money.js';
import { validDate } from '../obligations/calendar.js';
import { columnName } from './workbook.js';
const types = { Prestatarios: 'BORROWER', Prestamos: 'LOAN', Cuentas: 'ACCOUNT', Obligaciones: 'LIABILITY', Activos: 'ASSET', Fuentes: 'SOURCE', Antecedentes: 'INFORMATIONAL' };
export function normalizeWorkbook(parsed, scope, expected, idFactory = () => randomUUID()) {
    const data = parsed.data, defs = dictionary(), issues = [...parsed.issues], aliases = Object.create(null), externalRefs = [], commands = [], links = [], informationals = [];
    const totals = Object.fromEntries(['assets', 'liabilities', 'equity', 'debit', 'credit', 'difference', 'principal', 'recognizedInterest', 'informationalInterest'].map(k => [k, '0.00']));
    const issue = (sheet, index, field, code, kind = 'REFERENCE', severity = 'ERROR') => issues.push({ sheet, row: index + 2, cell: columnName(Math.max(0, defs.sheets.find(x => x.name === sheet)?.columns.findIndex(c => c.name === field) ?? 0) + 1) + (index + 2), code, severity, expectedType: kind, relatedKeys: [] });
    const control = {};
    for (const [i, r] of data['Control'].entries()) {
        const key = String(r['key']);
        if (Object.hasOwn(control, key) || !defs.controlKeys.includes(key))
            issue('Control', i, 'key', 'DUPLICATE_KEY', 'TEXT');
        control[key] = r['value'];
    }
    if (control['templateVersion'] !== '1.0.0' || control['mappingVersion'] !== 'S11-MAP-1' || control['mode'] !== expected.mode || control['namespace'] !== expected.namespace || control['currency'] !== 'COP' || control['timezone'] !== 'America/Bogota')
        issue('Control', 0, 'value', 'TYPE_INVALID', 'MODE');
    const cutoff = typeof control['cutoffDate'] === 'string' ? control['cutoffDate'] : null;
    if (cutoff && !validDate(cutoff))
        issue('Control', 0, 'value', 'INVALID_DATE', 'DATE_ISO');
    for (const [sheet, rows] of Object.entries(data)) {
        const seen = new Set();
        for (const [i, row] of rows.entries()) {
            if (sheet === 'Control')
                continue;
            const key = String(row['externalKey'] ?? '').trim().normalize('NFC');
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) || seen.has(key))
                issue(sheet, i, 'externalKey', 'DUPLICATE_KEY', 'TEXT');
            seen.add(key);
            const existing = row['existingId'];
            aliases[sheet + ':' + key] = typeof existing === 'string' ? existing : idFactory();
            if (['CREATE', 'HISTORICAL_DECLARED'].includes(String(row['action'])) && existing !== undefined)
                issue(sheet, i, 'existingId', 'TYPE_INVALID', 'REFERENCE');
            if (types[sheet])
                externalRefs.push({ key, type: types[sheet], id: aliases[sheet + ':' + key] });
            for (const [col, v] of Object.entries(row)) {
                const def = defs.sheets.find(s => s.name === sheet)?.columns.find(c => c.name === col);
                if (!def)
                    continue;
                if (def.type === 'DATE_ISO' && typeof v === 'string' && !validDate(v))
                    issue(sheet, i, col, 'INVALID_DATE', 'DATE_ISO');
                if (def.type === 'MONEY2' && !(sheet === 'Apertura' && row['category'] === 'EQUITY') && !exchangeContract().valid('Money', v))
                    issue(sheet, i, col, 'INVALID_MONEY', 'MONEY2');
            }
        }
    }
    const local = (v, sheet) => {
        if (typeof v !== 'string')
            throw Error('REFERENCE');
        if (v.startsWith('@')) {
            const id = aliases[sheet + ':' + v.slice(1)];
            if (!id)
                throw Error('REFERENCE');
            return id;
        }
        if (!exchangeContract().valid('Id', v))
            throw Error('REFERENCE');
        return v;
    };
    const supports = (v) => { if (typeof v !== 'string' || !v)
        throw Error('REFERENCE'); const keys = v.split(';'); if (new Set(keys).size !== keys.length)
        throw Error('REFERENCE'); return keys.map(k => local('@' + k, 'Soportes')); };
    const payload = (v) => jsonText(v);
    const parseArray = (v) => { if (typeof v !== 'string')
        throw Error('TYPE'); const parsed = JSON.parse(v); canonical(parsed); if (!Array.isArray(parsed))
        throw Error('TYPE'); return parsed; };
    const add = (operationId, row, p, pathReferences = {}) => {
        const c = { operationId, externalKey: String(row['externalKey']), pathReferences, expectedETag: typeof row['expectedETag'] === 'string' ? row['expectedETag'] : null, payload: p, dependsOnKeys: typeof row['dependsOnKeys'] === 'string' ? row['dependsOnKeys'].split(';') : [] };
        const { dependsOnKeys, ...check } = c;
        void dependsOnKeys;
        if (!exchangeContract().valid('DomainCommand', check))
            throw Error('TYPE');
        if (commands.some(x => x.externalKey === c.externalKey))
            throw Error('DUPLICATE');
        commands.push(c);
    };
    const prefix = scope.kind === 'BUSINESS' ? 'business' : 'personal';
    for (const [sheet, rows] of Object.entries(data))
        for (const [i, row] of rows.entries())
            if (row['supportKeys'])
                try {
                    supports(row['supportKeys']);
                }
                catch {
                    issue(sheet, i, 'supportKeys', 'REFERENCE_INVALID');
                }
    for (const [i, row] of data['Antecedentes'].entries())
        try {
            const supportIds = supports(row['supportKeys']), key = row['referenceKey'];
            let referenceId = null;
            if (key) {
                if (typeof key === 'string' && key.startsWith('@')) {
                    const matches = Object.entries(aliases).filter(([name]) => ['Cuentas', 'Prestatarios', 'Prestamos', 'Activos', 'Obligaciones'].includes(name.split(':')[0]) && name.endsWith(':' + key.slice(1)));
                    if (matches.length !== 1)
                        throw Error('REFERENCE');
                    referenceId = matches[0][1];
                }
                else {
                    exchangeContract().validate('Id', key);
                    referenceId = String(key);
                }
            }
            informationals.push({ id: aliases['Antecedentes:' + row['externalKey']], externalKey: row['externalKey'], date: row['date'], description: row['description'], supportIds, referenceId, supportReferences: data['Soportes'].filter(r => supportIds.includes(aliases['Soportes:' + r['externalKey']])).map(r => ({ reference: r['reference'], asOfDate: r['asOfDate'], declaration: r['declaration'] })) });
        }
        catch {
            issue('Antecedentes', i, 'supportKeys', 'REFERENCE_INVALID');
        }
    let opening = null;
    if (expected.mode === 'OPENING') {
        if (scope.kind !== 'BUSINESS' || !cutoff)
            issue('Control', 0, 'value', 'MODE_UNSUPPORTED', 'MODE');
        const references = [], components = [], interests = [], supportRows = [];
        for (const [i, r] of data['Soportes'].entries())
            try {
                supportRows.push({ id: aliases['Soportes:' + r['externalKey']], reference: r['reference'], asOfDate: r['asOfDate'], declaration: r['declaration'], ...(r['note'] ? { note: r['note'] } : {}) });
            }
            catch {
                issue('Soportes', i, 'externalKey', 'REFERENCE_INVALID');
            }
        for (const [sheet, type] of [['Prestatarios', 'BORROWER'], ['Prestamos', 'HISTORICAL_LOAN'], ['Obligaciones', 'OBLIGATION'], ['Activos', 'BASIC_ASSET']])
            for (const [i, r] of data[sheet].entries())
                try {
                    if (r['action'] !== 'OPENING_REFERENCE')
                        throw Error('MODE');
                    const base = { id: aliases[sheet + ':' + r['externalKey']], type, externalReference: r['externalKey'], supportIds: supports(r['supportKeys']) };
                    references.push(sheet === 'Prestatarios' ? { ...base, displayName: r['displayName'] } : sheet === 'Prestamos' ? { ...base, borrowerId: local(r['borrowerKey'], 'Prestatarios'), originationDate: r['originationDate'] } : sheet === 'Obligaciones' ? { ...base, counterpartyLabel: r['label'], incurredDate: cutoff } : { ...base, category: r['assetClass'], acquisitionDate: cutoff });
                }
                catch {
                    issue(sheet, i, 'action', 'MODE_UNSUPPORTED', 'MODE');
                }
        for (const [i, r] of data['Apertura'].entries())
            try {
                const category = String(r['category']), accountId = local(r['accountKey'], 'Cuentas'), referenceId = r['referenceKey'] ? local(r['referenceKey'], category === 'PRINCIPAL_RECEIVABLE' ? 'Prestamos' : category === 'LIABILITY' ? 'Obligaciones' : 'Activos') : null;
                components.push({ id: aliases['Apertura:' + r['externalKey']], category, accountId, amount: r['amount'], supportIds: supports(r['supportKeys']), ...(referenceId ? { referenceId } : {}), ...(r['equityKind'] ? { equityKind: r['equityKind'] } : {}) });
                const n = category === 'EQUITY' && String(r['amount']).startsWith('-') ? -cents(String(r['amount']).slice(1)) : cents(String(r['amount']));
                const key = category === 'EQUITY' ? 'equity' : category === 'LIABILITY' ? 'liabilities' : 'assets';
                totals[key] = money(BigInt(totals[key].replace('.', '')) + n);
                if (category === 'PRINCIPAL_RECEIVABLE')
                    totals['principal'] = money(BigInt(totals['principal'].replace('.', '')) + n);
            }
            catch {
                issue('Apertura', i, 'amount', 'INVALID_MONEY', 'MONEY2');
            }
        for (const [i, r] of data['Intereses'].entries())
            try {
                const recognized = r['treatment'] === 'RECOGNIZED_OPENING', amount = String(r['amount']);
                interests.push({ id: aliases['Intereses:' + r['externalKey']], loanReferenceId: local(r['loanKey'], 'Prestamos'), amount, treatment: r['treatment'], supportIds: supports(r['supportKeys']), ...(recognized ? { accountId: local(r['accountKey'], 'Cuentas'), equityComponentId: local(r['equityComponentKey'], 'Apertura'), recognitionDeclaration: r['recognitionDeclaration'] } : {}) });
                const k = recognized ? 'recognizedInterest' : 'informationalInterest';
                totals[k] = money(BigInt(totals[k].replace('.', '')) + cents(amount));
                if (recognized)
                    totals['assets'] = money(BigInt(totals['assets'].replace('.', '')) + cents(amount));
            }
            catch {
                issue('Intereses', i, 'amount', 'INTEREST_MISMATCH', 'MONEY2');
            }
        const a = BigInt(totals['assets'].replace('.', '')), l = BigInt(totals['liabilities'].replace('.', '')), q = BigInt(totals['equity'].replace('.', ''));
        totals['difference'] = money(a - l - q);
        totals['debit'] = money(a + (q < 0n ? -q : 0n));
        totals['credit'] = money(l + (q > 0n ? q : 0n));
        if (a - l - q !== 0n)
            issue('Apertura', 0, 'amount', 'BALANCE_DIFFERENCE', 'BALANCE');
        opening = { cutoffDate: cutoff, supports: supportRows, references, components, historicalInterest: interests, informationalHistory: informationals.map(r => ({ id: r['id'], date: r['date'], description: r['description'], supportIds: r['supportIds'], ...(r['referenceId'] ? { referenceId: r['referenceId'] } : {}) })) };
        if (Buffer.byteLength(JSON.stringify(opening)) > 65536 || [references, components, supportRows, interests, informationals].some(xs => xs.length > 100))
            issue('Control', 0, 'value', 'LIMIT_EXCEEDED', 'MODE');
        if (data['Cuotas'].length || data['Operaciones'].length || data['Fuentes'].length)
            issue('Control', 0, 'value', 'MODE_UNSUPPORTED', 'MODE');
    }
    else {
        for (const [i, r] of data['Cuentas'].entries())
            try {
                if (r['action'] === 'CREATE')
                    add(scope.kind === 'BUSINESS' ? 'createAccount' : 'createPersonalAccount', r, { code: r['code'], name: r['name'], accountClass: r['accountClass'], kind: r['kind'], currency: r['currency'] });
                else if (r['action'] !== 'LINK')
                    throw Error('MODE');
            }
            catch {
                issue('Cuentas', i, 'action', 'TYPE_INVALID', 'MODE');
            }
        for (const [i, r] of data['Prestatarios'].entries())
            try {
                if (r['action'] === 'CREATE') {
                    if (scope.kind !== 'BUSINESS')
                        throw Error('MODE');
                    add('createBorrower', r, { borrowerCode: r['code'], profile: { displayName: r['displayName'], schemaVersion: r['schemaVersion'], extras: r['extrasJson'] ? payload(r['extrasJson']) : {}, ...(r['documentNumber'] ? { document: { type: r['documentType'], number: r['documentNumber'] } } : {}), ...(r['email'] || r['phone'] ? { contact: { ...(r['email'] ? { email: r['email'] } : {}), ...(r['phone'] ? { phone: r['phone'] } : {}) } } : {}) } });
                }
                else if (r['action'] !== 'LINK')
                    throw Error('MODE');
            }
            catch {
                issue('Prestatarios', i, 'action', 'TYPE_INVALID', 'MODE');
            }
        for (const [i, r] of data['Prestatarios'].entries())
            if (r['action'] === 'CREATE' && r['openingReferenceKey'])
                try {
                    const command = commands.find(c => c.operationId === 'createBorrower' && c.externalKey === r['externalKey']);
                    command.payload['openingBorrowerReference'] = { openingId: local(control['openingId'], 'Control'), referenceId: local(r['openingReferenceKey'], 'Prestatarios') };
                    const { dependsOnKeys, ...check } = command;
                    void dependsOnKeys;
                    exchangeContract().validate('DomainCommand', check);
                }
                catch {
                    issue('Prestatarios', i, 'openingReferenceKey', 'REFERENCE_INVALID');
                }
        for (const [i, r] of data['Obligaciones'].entries())
            try {
                if (r['action'] === 'CREATE') {
                    add(prefix + 'CreateLiability', r, { kind: r['kind'], label: r['label'], counterpartyReference: r['counterpartyReference'], principal: r['principal'], rate: payload(r['rateJson']), schedule: payload(r['scheduleJson']), prepaymentPermissions: parseArray(r['prepaymentPermissionsJson']), supportReference: r['supportReference'] });
                    if (r['openingComponentKey'])
                        links.push({ ...r, kind: 'LIABILITY', id: aliases['Obligaciones:' + r['externalKey']], expectedETag: '"' + aliases['Obligaciones:' + r['externalKey']] + ':1"' });
                }
                else if (r['action'] === 'LINK')
                    links.push({ ...r, kind: 'LIABILITY', id: aliases['Obligaciones:' + r['externalKey']] });
                else
                    throw Error('MODE');
            }
            catch {
                issue('Obligaciones', i, 'action', 'TYPE_INVALID', 'MODE');
            }
        for (const [i, r] of data['Activos'].entries())
            try {
                if (['INHERITANCE', 'DONATION', 'CONSTRUCTION', 'EXCHANGE'].includes(String(r['origin'])))
                    issue('Activos', i, 'origin', 'AP10_A3_DEFERRED', 'MODE', 'DEFERRED');
                if (r['action'] === 'CREATE')
                    add(prefix + 'CreateAssetDraft', r, { assetClass: r['assetClass'], otherClassDescription: r['otherClassDescription'] ?? null, label: r['label'], origin: r['origin'], legalOwnerReference: r['legalOwnerReference'], ownershipPercentage: r['ownershipPercentage'] ?? null, grossCostDeclared: r['grossCostDeclared'] ?? null, assetAccountId: local(r['assetAccountKey'], 'Cuentas'), supportReferences: String(r['supportKeys']).split(';').map(k => String(data['Soportes'].find(x => x['externalKey'] === k)?.['reference'] ?? '')), locationGeneral: r['locationGeneral'] ?? null });
                else if (r['action'] === 'LINK')
                    links.push({ kind: 'ASSET', ...r, id: aliases['Activos:' + r['externalKey']] });
                else
                    throw Error('MODE');
            }
            catch {
                issue('Activos', i, 'action', 'TYPE_INVALID', 'MODE');
            }
        for (const [i, r] of data['Prestamos'].entries())
            try {
                if (expected.mode !== 'HISTORICAL_LINK' || scope.kind !== 'BUSINESS' || r['action'] !== 'HISTORICAL_DECLARED')
                    throw Error('MODE');
                const quotas = data['Cuotas'].filter(q => q['loanKey'] === '@' + r['externalKey']);
                if (!quotas.length || quotas.reduce((n, q) => n + cents(String(q['principalRemaining'])), 0n) !== cents(String(r['principalOutstanding'])))
                    issue('Prestamos', i, 'principalOutstanding', 'SCHEDULE_DIFFERENCE', 'MONEY2');
                links.push({ kind: 'LOAN', ...r, id: aliases['Prestamos:' + r['externalKey']], borrowerId: local(r['borrowerKey'], 'Prestatarios'), openingId: r['openingId'] ?? control['openingId'], principalComponentId: local(r['principalComponentKey'], 'Apertura'), loanReferenceId: local(r['openingReferenceKey'], 'Prestamos'), installments: quotas });
                totals['principal'] = money(cents(totals['principal']) + cents(String(r['principalOutstanding'])));
                totals['recognizedInterest'] = money(cents(totals['recognizedInterest']) + quotas.reduce((n, q) => n + cents(String(q['recognizedInterestRemaining'])), 0n));
                totals['informationalInterest'] = money(cents(totals['informationalInterest']) + quotas.reduce((n, q) => n + cents(String(q['unrecognizedInterestRemaining'])), 0n));
            }
            catch {
                issue('Prestamos', i, 'action', 'MODE_UNSUPPORTED', 'MODE');
            }
        const referenceFields = { accountId: 'Cuentas', assetAccountId: 'Cuentas', backingAccountId: 'Cuentas', principalAccountId: 'Cuentas', plannedFundingAccountId: 'Cuentas', borrowerId: 'Prestatarios', assetId: 'Activos', liabilityId: 'Obligaciones', fundId: 'Operaciones', quoteId: 'Prestamos' };
        const resolveJson = (v, key = '') => Array.isArray(v) ? v.map(x => resolveJson(x, key)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveJson(x, k)])) : typeof v === 'string' && v.startsWith('@') && referenceFields[key] ? local(v, referenceFields[key]) : v;
        for (const [i, r] of data['Operaciones'].entries())
            try {
                const op = String(r['operationId']);
                if (scope.kind === 'PERSONAL' && !op.startsWith('personal') && op !== 'createPersonalAccount' || scope.kind === 'BUSINESS' && (op.startsWith('personal') || op === 'createPersonalAccount'))
                    throw Error('MODE');
                const p = resolveJson(payload(r['commandJson']));
                const id = r['entityKey'] ? local(r['entityKey'], op.includes('Fund') ? 'Operaciones' : op.includes('Liability') ? 'Obligaciones' : 'Activos') : null;
                const ps = id ? { [op.includes('Fund') ? 'fundId' : op.includes('Liability') ? 'liabilityId' : 'assetId']: id } : {};
                add(op, r, p, ps);
            }
            catch {
                issue('Operaciones', i, 'commandJson', 'TYPE_INVALID', 'JSON_TEXT');
            }
        for (const [i, r] of data['Fuentes'].entries())
            try {
                const id = local(r['assetKey'], 'Activos'), root = commands.find(c => c.pathReferences['assetId'] === id && c.operationId.endsWith('AcquireAsset')), funding = root?.payload['funding'];
                if (!funding || !funding.some(f => f['nature'] === r['nature'] && f['settlementMode'] === r['settlementMode'] && f['amount'] === r['amount'] && f['reference'] === r['reference'] && f['provenanceKind'] === r['provenanceKind'] && (f['accountId'] ?? f['principalAccountId']) === local(r['accountKey'], 'Cuentas')))
                    throw Error('REFERENCE');
            }
            catch {
                issue('Fuentes', i, 'assetKey', 'REFERENCE_INVALID');
            }
        if (data['Apertura'].length || data['Intereses'].length)
            issue('Control', 0, 'value', 'MODE_UNSUPPORTED', 'MODE');
        if (expected.mode === 'INFORMATIONAL' && (commands.length || links.length))
            issue('Control', 0, 'value', 'MODE_UNSUPPORTED', 'MODE');
    }
    const values = (v) => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(values) : v && typeof v === 'object' ? Object.values(v).flatMap(values) : [];
    for (const c of commands) {
        const refs = new Set([...values(c.payload), ...Object.values(c.pathReferences)]);
        for (const other of commands) {
            if (other === c)
                continue;
            const entry = Object.entries(aliases).find(([k]) => k.endsWith(':' + other.externalKey));
            if (entry && refs.has(entry[1]))
                c.dependsOnKeys = [...new Set([...(c.dependsOnKeys ?? []), other.externalKey])];
        }
    }
    const sorted = [], pending = [...commands].sort((a, b) => a.externalKey < b.externalKey ? -1 : 1);
    while (pending.length) {
        const at = pending.findIndex(c => (c.dependsOnKeys ?? []).every(k => sorted.some(p => p.externalKey === k)));
        if (at < 0) {
            issue('Operaciones', 0, 'dependsOnKeys', 'REFERENCE_INVALID');
            break;
        }
        sorted.push(pending.splice(at, 1)[0]);
    }
    if (commands.length + links.length > 100)
        issue('Control', 0, 'value', 'LIMIT_EXCEEDED', 'MODE');
    const plan = { mode: expected.mode, namespace: expected.namespace, cutoffDate: cutoff, commands: sorted, links, opening, informationals, aliases, externalRefs, issues, totals, totalRows: parsed.rows, semanticHash: workbookIdentity(data, { bookId: scope.bookId, ownerId: scope.ownerId, kind: scope.kind }), normalized: data };
    if (Buffer.byteLength(JSON.stringify(plan)) > 524288)
        throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
    return plan;
}
//# sourceMappingURL=normalizer.js.map