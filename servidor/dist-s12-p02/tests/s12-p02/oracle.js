/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- Synthetic workbook field traversal and exact own guarded BUILD-STATE path; no executable input or historical writer. */
import { join } from 'node:path';
import { simulationContract } from '../../src/modules/simulation/contract.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseWorkbook } from '../../src/modules/exchange/workbook.js';
import { today } from '../../src/modules/obligations/calendar.js';
import { operationsEvidenceMatches } from '../../src/modules/lending/operations-service.js';
import { table } from '../../src/modules/obligations/models.js';
import { paymentContract } from '../../src/modules/payments/contract.js';
import { readFileSync } from 'node:fs';
import { dictionary } from '../../src/modules/exchange/contract.js';
import { readZip, writeZip } from '../../src/modules/exchange/zip.js';
import { columnName } from '../../src/modules/exchange/workbook.js';
import { xmlEscape } from '../../src/modules/exchange/xml.js';
export const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const base = (flows = [], overrides = {}) => ({ id: uid(1), targetBookId: uid(2), asOf: '2026-10-31', knownAt: '2026-10-31T17:00:00Z', sourceDigest: 'a'.repeat(64), books: [{ bookId: uid(2), kind: 'BUSINESS', cashBook: '0.00', available: '0.00', reserved: '0.00', held: '0.00', custodyProvisional: '0.00', custodyConfirmed: '0.00', committed: '0.00', principalOutstanding: '0.00', recognizedInterest: '0.00', ownDebt: '0.00', netWorthBook: '0.00', estimatedOwnValue: '0.00', netWorthIndicative: '0.00', assetCost: '0.00', funds: [], terms: [], flows, sourceRefs: [], coverage: 'COMPLETE', reasons: [], ...overrides }] });
export function definition(alt) { return { baseId: uid(1), baseToken: 'synthetic', horizonDays: 30, assumptions: ['PRUDENT', 'BASE', 'FAVORABLE'].map(kind => ({ kind: kind, collectionFraction: '1.000000', delayDays: 0, recoveryFraction: '0.000000', recoveryDelayDays: 0, interestProjection: 'DECLARED_SCHEDULE_ONLY', dateOverrides: [], capitalEvents: [] })), alternatives: ['HOLD_CASH', 'DEBT_PREPAYMENT', 'NEW_LOAN', 'ASSET_PURCHASE'].map(kind => alt?.kind === kind ? alt : kind === 'HOLD_CASH' ? { kind, budget: alt?.budget ?? '0.00', configured: true, reserveReleases: [] } : { kind: kind, budget: alt?.budget ?? '0.00', configured: false, reason: 'NOT_CONFIGURED' }) }; }
export const flow = (n, date, direction, amount, classification = 'EXPENSE') => ({ id: uid(n), sourceKey: uid(n), bookId: uid(2), date, direction, classification, amount, sourceRefs: [], entityId: uid(n), installment: null });
// Workbook mechanics copied read-only from S11-P04 oracle; no historical fixture or writer imported.
export function workbook(mode, namespace, rows, control = {}) {
    const parts = readZip(readFileSync('../../Construccion/Sprints/S11/Plantillas/v1.0.0/caudelyx-import-template.xlsx'));
    const controls = { templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1', mode, namespace, currency: 'COP', timezone: 'America/Bogota', ...control };
    const data = { ...rows, Control: Object.entries(controls).map(([key, value]) => ({ key, value })) };
    for (const [i, sheet] of dictionary().sheets.entries()) {
        const records = [Object.fromEntries(sheet.columns.map(c => [c.name, c.name])), ...(data[sheet.name] ?? [])];
        const body = records.map((r, row) => '<x:row r="' + (row + 1) + '">' + sheet.columns.flatMap((c, col) => { const value = r[c.name]; if (value === undefined)
            return []; const address = columnName(col + 1) + (row + 1); return typeof value === 'number' ? ['<x:c r="' + address + '"><x:v>' + value + '</x:v></x:c>'] : ['<x:c r="' + address + '" t="inlineStr"><x:is><x:t xml:space="preserve">' + xmlEscape(String(value)) + '</x:t></x:is></x:c>']; }).join('') + '</x:row>').join(''), name = 'xl/worksheets/sheet' + (i + 1) + '.xml', xml = parts.get(name).toString('utf8');
        // eslint-disable-next-line security/detect-unsafe-regex -- Fixed immutable template XML, no client input or unbounded nested alternation.
        if (!/<x:sheetData(?:\s[^>]*)?>[\s\S]*?<\/x:sheetData>/.test(xml))
            throw Error('Independent fixture template structure changed');
        parts.set(name, Buffer.from(xml.replace(/<x:sheetData(?:\s[^>]*)?>[\s\S]*?<\/x:sheetData>/, '<x:sheetData>' + body + '</x:sheetData>')));
    }
    return writeZip(parts);
}
// Own fixture seed copied and adapted from read-only S11-P04 mechanics; no old logger/runner/fixture.
export async function historicalSeed(f) {
    const service = f.identity.exchange;
    const b = await f.actor(), org2 = (await f.runtime.organizations.create(b.issued.context, { name: 'Apertura sintética S11', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id, p2 = { organizationId: org2 }, sample = parseWorkbook(await readFile('../../Construccion/Sprints/S11/Plantillas/v1.0.0/opening-600.xlsx')), cutoff = String(sample.data['Control'].find(r => r['key'] === 'cutoffDate')['value']), accountIds = new Map();
    // Own generated variant: cash 80 + principal 200 + property 300 + recognized
    // interest 20 = 600. Frozen sample bytes remain untouched; equity 450/debt150.
    sample.data['Apertura'].find(r => r['externalKey'] === 'cash1')['amount'] = '80.00';
    sample.data['Cuentas'].push({ externalKey: 'interest', action: 'LINK', existingId: '11111111-1111-4111-8111-111111111111', expectedETag: '"SYN:1"', code: 'INTEREST_OPENING', name: 'Interés reconocido sintético', accountClass: 'ASSET', kind: 'GENERAL', currency: 'COP' });
    sample.data['Apertura'].find(r => r['externalKey'] === 'equity1')['amount'] = '430.00';
    sample.data['Apertura'].push({ externalKey: 'history-equity', category: 'EQUITY', accountKey: '@equity', amount: '20.00', equityKind: 'HISTORICAL_RESULTS', supportKeys: 'support1' });
    sample.data['Intereses'] = [{ externalKey: 'recognized', loanKey: '@loan1', amount: '20.00', treatment: 'RECOGNIZED_OPENING', accountKey: '@interest', equityComponentKey: '@history-equity', recognitionDeclaration: 'Saldo sintético declarado reconocido al corte', supportKeys: 'support1' }];
    sample.data['Obligaciones'][0]['principal'] = '100.00';
    sample.data['Obligaciones'].push({ ...sample.data['Obligaciones'][0], externalKey: 'debt2', principal: '50.00', label: 'Segunda deuda sintética' });
    sample.data['Apertura'].find(r => r['externalKey'] === 'debt-component')['amount'] = '100.00';
    sample.data['Apertura'].push({ externalKey: 'debt-component2', category: 'LIABILITY', accountKey: '@debt', amount: '50.00', referenceKey: '@debt2', supportKeys: 'support1' });
    for (const row of sample.data['Cuentas']) {
        const payload = { code: row['code'], name: row['name'], accountClass: row['accountClass'], kind: row['kind'], currency: 'COP' }, created = await f.runtime.finance.mutate(b.issued.context, 'createAccount', org2, payload, randomUUID()), id = String(created.data['id']);
        accountIds.set(String(row['existingId']), id);
        row['existingId'] = id;
        row['expectedETag'] = created.etag;
    }
    // References may be aliases or source UUIDs; replace only exact fixture UUIDs.
    for (const rows of Object.values(sample.data))
        for (const row of rows)
            for (const [k, value] of Object.entries(row))
                if (typeof value === 'string')
                    for (const [old, id] of accountIds)
                        if (value === old)
                            row[k] = id;
    const startImport = async (mode, namespace, bytes, previewInput = {}) => { const created = await service.createImport(b.issued.context, 'createBusinessImport', { label: 'Origen sintético', mode, namespace, templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, p2, randomUUID()), ps = { ...p2, importId: String(created.data['id']) }, uploaded = await service.upload(b.issued.context, ps, randomUUID(), created.etag, bytes), job = await service.preparePreview(b.issued.context, ps, randomUUID(), uploaded.etag, previewInput), preview = await service.readImport(b.issued.context, ps, 'getBusinessImportPreview'); assert.equal(job.data['state'], 'SUCCEEDED'); assert.equal(preview.data['canConfirm'], true, JSON.stringify(preview.data)); return { ps, preview, current: await service.readImport(b.issued.context, ps, 'getBusinessImport') }; };
    const opened = await startImport('OPENING', 'SYN-S11-OPENING', workbook('OPENING', 'SYN-S11-OPENING', sample.data, { cutoffDate: cutoff })), snapshot = opened.preview.data['openingSnapshot'];
    assert.equal(opened.preview.data['totals'] && opened.preview.data['totals']['assets'], '600.00');
    const native = f.runtime.opening, created = await native.mutate(b.issued.context, 'createOpening', org2, { snapshot }, randomUUID()), openingId = String(created.data['id']), validated = await native.mutate(b.issued.context, 'validateOpening', org2, { policyVersion: 'S03-OPENING-0.1' }, randomUUID(), openingId, created.etag), validation = validated.data['validation'];
    assert.ok(validation, JSON.stringify(validated.data['report']));
    const binding = { validationId: validation['id'], validationFingerprint: validation['fingerprint'] }, approved = await native.mutate(b.issued.context, 'approveOpening', org2, binding, randomUUID(), openingId, validated.etag), commit = { ...binding, importBridge: { importId: opened.ps.importId, previewId: opened.preview.data['id'], semanticHash: opened.preview.data['semanticHash'], openingId, validationId: validation['id'], openingFingerprint: validation['fingerprint'] } }, openingKey = randomUUID();
    await f.proof(b, 'OPENING_COMMIT', { organizationId: org2, idempotencyKey: openingKey, expectedETag: approved.etag, payload: commit }, openingId);
    assert.equal((await native.mutate(b.issued.context, 'commitOpening', org2, commit, openingKey, openingId, approved.etag)).status, 201);
    assert.equal((await service.readImport(b.issued.context, opened.ps, 'getBusinessImport')).data['state'], 'COMMITTED');
    assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: org2 }), 1);
    assert.equal(await f.database.db.collection('loan_operation_books').countDocuments({ organizationId: org2 }), 0);
    const source = await native.files.findOne({ _id: openingId });
    assert.ok(source?.commit);
    const principal = source.snapshot.components.find(c => c.category === 'PRINCIPAL_RECEIVABLE'), reference = source.snapshot.references.find(r => r.id === principal.referenceId), borrowerReference = source.snapshot.references.find(r => r.id === reference.borrowerId), recognized = source.snapshot.historicalInterest.filter(i => i.loanReferenceId === reference.id && i.treatment === 'RECOGNIZED_OPENING'), informational = source.snapshot.historicalInterest.filter(i => i.loanReferenceId === reference.id && i.treatment === 'INFORMATIONAL');
    assert.equal(principal.amount, '200.00');
    assert.equal(recognized[0].amount, '20.00');
    assert.equal(informational.length, 0);
    const extra = async (code, accountClass) => String((await f.runtime.finance.mutate(b.issued.context, 'createAccount', org2, { code, name: 'Cuenta sintética ' + code, accountClass, kind: 'GENERAL', currency: 'COP' }, randomUUID())).data['id']), profile = { principalAccountId: principal.accountId, interestReceivableAccountId: recognized[0].accountId, interestIncomeAccountId: await extra('HIST_INCOME', 'INCOME'), borrowerCreditAccountId: await extra('HIST_CREDIT', 'LIABILITY') }, versions = {};
    for (const role of Object.keys(profile))
        versions[role] = (await f.runtime.finance.read(b.issued.context, 'readAccount', org2, profile[role])).etag;
    const debts = source.snapshot.components.filter(c => c.category === 'LIABILITY'), obligations = debts.map((c, i) => ({ externalKey: 'DEBT_' + i, action: 'CREATE', kind: 'BANK_LOAN', label: 'Deuda histórica sintética ' + i, counterpartyReference: 'SYN-LENDER', principal: c.amount, rateJson: JSON.stringify({ kind: 'NONE_DECLARED', source: 'SYNTHETIC_DECLARED', sourceReference: 'SYN', validFrom: cutoff, observedOn: cutoff, unit: 'ANNUAL_FRACTION', convention: 'ANNUAL_SIMPLE_ACT_365', decimalValue: '0.00', combine: 'NONE' }), scheduleJson: JSON.stringify({ kind: 'OFFICIAL_DECLARED', validFrom: cutoff, referenceDate: cutoff, sourceReference: 'SYN', principalOpening: c.amount, rateVersionIds: [], installments: [{ number: 1, dueDate: today(f.now()), principal: c.amount, interest: '0.00', insurance: '0.00', fees: '0.00', total: c.amount }] }), prepaymentPermissionsJson: '[]', supportReference: 'SYN', recognitionKind: 'EXISTING_JOURNAL_LINK', principalAccountKey: c.accountId, openingId, openingComponentKey: c.id, supportKeys: 'SYN' }));
    const historical = await startImport('HISTORICAL_LINK', 'SYN-S11-HISTORY', workbook('HISTORICAL_LINK', 'SYN-S11-HISTORY', { Obligaciones: obligations, Prestatarios: [{ externalKey: 'BORROWER', action: 'CREATE', code: 'HIST_BORROWER', displayName: 'Persona histórica sintética', schemaVersion: 1, openingReferenceKey: borrowerReference.id, supportKeys: 'SYN' }], Prestamos: [{ externalKey: 'LOAN', action: 'HISTORICAL_DECLARED', borrowerKey: '@BORROWER', openingId, openingReferenceKey: reference.id, principalComponentKey: principal.id, originationDate: reference.originationDate, principalOutstanding: principal.amount, scheduleVersion: 1, supportKeys: 'SYN' }], Cuotas: [{ externalKey: 'QUOTA', loanKey: '@LOAN', scheduleVersion: 1, number: 1, dueDate: cutoff, principalRemaining: '200.00', recognizedInterestRemaining: '20.00', unrecognizedInterestRemaining: '10.00', supportKeys: 'SYN' }], Soportes: [{ externalKey: 'SYN', reference: 'SYNTHETIC-RESIDUAL-DECLARED', asOfDate: cutoff, declaration: 'DECLARED' }] }, { cutoffDate: cutoff, openingId }), { historicalProfiles: [{ externalKey: 'LOAN', accountProfile: profile, accountVersions: versions }] }), bookETag = await f.database.client.withSession(s => f.runtime.wealth.bookTag({ kind: 'BUSINESS', bookId: org2, ownerId: org2, organizationId: org2 }, s)), payload = { previewId: historical.preview.data['id'], semanticHash: historical.preview.data['semanticHash'], bookETag }, key = randomUUID();
    const receipt = await service.confirm(b.issued.context, historical.ps, payload, key, historical.current.etag);
    assert.equal(receipt.status, 201);
    assert.deepEqual(receipt.data['journalIds'], []);
    assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: org2 }), 1);
    assert.equal(await f.runtime.lending.loans.countDocuments({ organizationId: org2 }), 0);
    assert.equal(await f.runtime.lending.quotes.countDocuments({ organizationId: org2 }), 0);
    assert.equal(await f.runtime.operations.events.countDocuments({ organizationId: org2 }), 0);
    assert.equal(await f.runtime.operations.accruals.countDocuments({ organizationId: org2 }), 0);
    assert.equal(await operationsEvidenceMatches(f.database), true);
    assert.equal(await f.database.db.collection(table('BUSINESS', 'liabilities')).countDocuments({ bookId: org2, status: 'ACTIVE' }), 2);
    assert.equal(await f.database.db.collection('s11_opening_component_claims').countDocuments({ bookId: org2 }), 4);
    assert.equal(receipt.data['totals']['principal'], '200.00');
    assert.equal(receipt.data['totals']['recognizedInterest'], '20.00');
    const unitEvents = await f.database.db.collection(table('BUSINESS', 'events')).find({ bookId: org2, kind: 'LIABILITY_ACTIVATE' }).toArray();
    assert.equal(unitEvents.length, 2);
    assert.ok(unitEvents.every(e => e['unitKnownAt'] === receipt.data['committedAt']));
    assert.equal((await f.database.db.collection('s11_historical_origins').findOne({ bookId: org2 }))['createdAt'], receipt.data['committedAt']);
    assert.equal(await f.database.db.collection(table('BUSINESS', 'history')).countDocuments({ bookId: org2 }), 0);
    const resolved = receipt.data['resolvedRefs'], loanId = String(resolved.find(x => x['entityType'] === 'LOAN')['id']), position = await f.runtime.operations.read(b.issued.context, 'getLoanPosition', org2, loanId);
    assert.equal(position.data['termsStatus'], 'HISTORICAL_DECLARED');
    assert.equal(position.data['accruedOutstandingInterest'], '20.00');
    assert.equal(position.data['dueUnrecognizedInterest'], '10.00');
    f.clock.value += 1000;
    const date = today(f.now()), portfolio = await service.report(b.issued.context, { ...p2, reportKind: 'PORTFOLIO' }, { asOf: date, from: date, to: date }), page = await service.reportPage(b.issued.context, { ...p2, reportKind: 'PORTFOLIO' }, { snapshotToken: portfolio.data['meta']['snapshotToken'] }), total = page.data['totals'].find(c => c['columnId'] === 'principal');
    assert.equal(decimal(String(total['value'])), 20000n);
    assert.equal(page.data['items'].filter(r => r['cells'].some(c => c['columnId'] === 'origin' && c['value'] === 'HISTORICAL_S11')).length, 1);
    const pay = f.runtime.payments, state = async () => (await pay.read(b.issued.context, 'getPaymentsState', org2)).data;
    const paymentCommand = async (operation, payload, id) => { const versions = await state(), key = randomUUID(); await f.proof(b, paymentContract().purpose(operation, payload), { organizationId: org2, idempotencyKey: key, expectedETag: versions['paymentsBookETag'], operationId: operation, resourceId: id ?? null, payload }, id); return await pay.mutate(b.issued.context, operation, org2, payload, key, String(versions['paymentsBookETag']), id); };
    const prepare = async (command) => { const versions = await state(), key = randomUUID(), preview = await pay.preview(b.issued.context, org2, { executionKey: key, expectedPaymentsETag: versions['paymentsBookETag'], command }), payload = { command, previewToken: preview.data['token'] }, operation = command['kind'] === 'REGISTER' ? 'registerPayment' : 'executePaymentReversal', id = command['kind'] === 'REGISTER' ? undefined : String(command['originalEventId']); await f.proof(b, paymentContract().purpose(operation, payload), { organizationId: org2, idempotencyKey: key, expectedETag: versions['paymentsBookETag'], operationId: operation, resourceId: id ?? null, payload }, id); return await pay.mutate(b.issued.context, operation, org2, payload, key, String(versions['paymentsBookETag']), id); };
    const heldId = await extra('HELD_S11', 'LIABILITY'), held = await f.runtime.finance.read(b.issued.context, 'readAccount', org2, heldId);
    await paymentCommand('setHeldFundsProfile', { configurationKind: 'HELD_FUNDS_PROFILE', heldLiabilityAccountId: heldId, heldLiabilityAccountETag: held.etag, resourceETag: '"' + org2 + ':held-profile:0"', supportReference: 'SYN-HELD' });
    const cashAccount = source.snapshot.components.find(c => c.category === 'BANK').accountId, cash = await f.runtime.finance.read(b.issued.context, 'readAccount', org2, cashAccount), intent = { method: 'BANK', borrowerId: String(position.data['borrower'] && position.data['borrower']['id']), amount: '50.00', currency: 'COP', destinationAccountId: cashAccount, destinationAccountETag: cash.etag, custodianId: null, bindingETag: null, observedDate: date, observedAt: new Date(f.now()).toISOString(), receiptReference: 'SYN-HISTORY-RECEIPT', supportReference: 'SYN-RESIDUAL', targets: [{ loanId, positionETag: position.etag, amount: '50.00', mode: 'REGULAR' }], excessDisposition: 'CREDIT' }, payment = await prepare({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: date, intent }), eventId = String(payment.data['eventId']), paymentId = String(payment.data['entityId']), after = await f.runtime.operations.read(b.issued.context, 'getLoanPosition', org2, loanId);
    assert.equal(after.data['principalOutstanding'], '180.00');
    assert.equal(after.data['accruedInterestTotal'], '30.00');
    assert.equal(after.data['collectedInterestTotal'], '30.00');
    assert.equal(await f.runtime.operations.accruals.countDocuments({ organizationId: org2 }), 1);
    assert.equal((await f.runtime.operations.accruals.findOne({ organizationId: org2 })).interest, '10.00');
    assert.equal(await operationsEvidenceMatches(f.database), true);
    await paymentCommand('requestPaymentReversal', { resourceETag: '"' + eventId + ':1"', reason: 'Corrección sintética', supportReference: 'SYN-REVERSE' }, eventId);
    const request = await pay.read(b.issued.context, 'getLoanEventReversalRequest', org2, eventId), versionsAfter = await state();
    await prepare({ kind: 'EXECUTE_REVERSAL', paymentId, originalEventId: eventId, resourceETag: request.etag, reversalRequestId: eventId, effectiveDate: date, expectedOperationsETag: versionsAfter['operationsBookETag'], supportReference: 'SYN-REVERSE' });
    const reversed = await f.runtime.operations.read(b.issued.context, 'getLoanPosition', org2, loanId);
    assert.equal(reversed.data['principalOutstanding'], '200.00');
    assert.equal(reversed.data['collectedInterestTotal'], '0.00');
    assert.equal(reversed.data['accruedInterestTotal'], '30.00');
    assert.equal(await operationsEvidenceMatches(f.database), true);
    return { actor: b, organizationId: org2, loanId, position: reversed, date, scope: { kind: 'BUSINESS', bookId: org2, ownerId: org2, organizationId: org2 } };
}
export function decimal(value) { if (!/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value))
    throw Error('Noncanonical oracle amount'); return BigInt(value.replace('.', '')); }
const ownGuard = await import(new URL('../../../scripts/s12-p02-guard.mjs', import.meta.url).href);
export async function recordExample(operation, input, params, result) {
    simulationContract().result(operation, result.status, { data: result.data, requestId: randomUUID() });
    const evidence = join(ownGuard.projectRoot, 'Construccion/Sprints/S12/Evidencias'), state = JSON.parse(await readFile(join(evidence, 'S12-P02-BUILD-STATE.json'), 'utf8'));
    await ownGuard.appendOwn(join(evidence, 'S12-P02-RUNTIME-EXAMPLES.jsonl'), JSON.stringify({ observedUTC: new Date().toISOString(), sourceKey: state.key, operation, request: input, pathParameters: params, response: result, usage: 'LOCAL_SYNTHETIC', note: 'Synthetic UUID group is destroyed after invocation. Base/cursor tokens are not authentication and expire300s. No cookies, CSRF, grants or keys.' }) + '\n');
}
//# sourceMappingURL=oracle.js.map