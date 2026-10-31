/* eslint-disable security/detect-object-injection -- Fixed sample paths, own evidence path and own synthetic maps only. */
// S11-P05 (Claude): economic review on ONE own Mongo group. Mechanics (actor/org/proof/world) come from the copied profile;
// expectations come from raw sheet rows (own reader) and raw financial_journals lines, summed with BigInt (book.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { s11Profile, world } from './profile.js';
import { readSample, workbook, cents, money, TEMPLATES } from './book.js';
import { today } from '../../src/modules/obligations/calendar.js';
const code = (e) => e.code ?? String(e.message).slice(0, 120);
const ORACLE = {}, CHECKS = {};
test('S11-P05 economy: opening 600, historical no-income, idempotency/repack/concurrency, 200M with protected reserve', { timeout: 900000 }, async (t) => {
    const group = await s11Profile();
    try {
        const f = await world(group, Date.parse('2026-10-31T12:00:00-05:00')), service = f.identity.exchange;
        const journals = f.database.db.collection('financial_journals'), accounts = f.database.db.collection('financial_accounts');
        // Raw oracle: per-class debit/credit totals from stored journal lines only.
        const raw = async (org) => {
            const classes = new Map((await accounts.find({ organizationId: org }).toArray()).map(a => [String(a['_id']), String(a['accountClass'])]));
            const js = await journals.find({ organizationId: org }).toArray(), out = {};
            let debit = 0n, credit = 0n;
            for (const j of js)
                for (const l of j['lines']) {
                    const c = classes.get(String(l['accountId'])) ?? 'UNKNOWN', d = cents(String(l['debit'])), k = cents(String(l['credit']));
                    (out[c] ??= { debit: 0n, credit: 0n });
                    out[c].debit += d;
                    out[c].credit += k;
                    debit += d;
                    credit += k;
                }
            return { journals: js.length, debit: money(debit), credit: money(credit), byClass: Object.fromEntries(Object.entries(out).map(([c, v]) => [c, { debit: money(v.debit), credit: money(v.credit) }])) };
        };
        const balanceOf = async (org, accountId) => { let n = 0n; for (const j of await journals.find({ organizationId: org }).toArray())
            for (const l of j['lines'])
                if (l['accountId'] === accountId)
                    n += cents(String(l['debit'])) - cents(String(l['credit'])); return money(n); };
        const start = async (actor, org, mode, namespace, bytes, input = {}) => {
            // Product rate limit is 10 exchange operations/60 s per actor+book on the synthetic clock: move past the window, never change the limit.
            f.clock.value += 61000;
            const p = { organizationId: org }, created = await service.createImport(actor.issued.context, 'createBusinessImport', { label: 'Revisión P05', mode, namespace, templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, p, randomUUID());
            const ps = { ...p, importId: String(created.data['id']) }, up = await service.upload(actor.issued.context, ps, randomUUID(), created.etag, bytes);
            const job = await service.preparePreview(actor.issued.context, ps, randomUUID(), up.etag, input);
            const current = await service.readImport(actor.issued.context, ps, 'getBusinessImport');
            const preview = current.data['state'] === 'CANCELLED' ? null : await service.readImport(actor.issued.context, ps, 'getBusinessImportPreview');
            return { ps, job, current, preview };
        };
        const confirm = async (actor, org, s, key = randomUUID(), tweak = {}) => {
            const bookETag = await f.database.client.withSession(x => f.runtime.wealth.bookTag({ kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org }, x));
            const payload = { previewId: s.preview.data['id'], semanticHash: s.preview.data['semanticHash'], bookETag, ...tweak };
            await f.proof(actor, 'IMPORT_CONFIRM', { operationId: 'confirmBusinessImport', organizationId: org, pathParameters: s.ps, payload, idempotencyKey: key, expectedETag: s.current.etag }, s.ps.importId);
            return { key, payload, run: () => service.confirm(actor.issued.context, s.ps, payload, key, s.current.etag) };
        };
        // ---------- A. Opening with the frozen opening-600 sample (no author variant) ----------
        const b = await f.actor(), org2 = (await f.runtime.organizations.create(b.issued.context, { name: 'Apertura revisión P05', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
        const sample = readSample(TEMPLATES + 'opening-600.xlsx'), control = Object.fromEntries((sample['Control'] ?? []).map(r => [String(r['key']), String(r['value'])]));
        const sheetOracle = (rows) => { const sumOf = (cats) => money((rows['Apertura'] ?? []).filter(r => cats.includes(String(r['category']))).reduce((n, r) => n + cents(String(r['amount'])), 0n)); return { assets: sumOf(['BANK', 'PRINCIPAL_RECEIVABLE', 'BASIC_ASSET']), liabilities: sumOf(['LIABILITY']), equity: sumOf(['EQUITY']) }; };
        ORACLE['opening-sheet'] = sheetOracle(sample);
        assert.deepEqual(ORACLE['opening-sheet'], { assets: '600.00', liabilities: '150.00', equity: '450.00' });
        const ids = new Map();
        for (const row of sample['Cuentas']) {
            const created = await f.runtime.finance.mutate(b.issued.context, 'createAccount', org2, { code: 'P05_' + String(row['code']), name: String(row['name']), accountClass: String(row['accountClass']), kind: String(row['kind']), currency: 'COP' }, randomUUID());
            ids.set(String(row['existingId']), String(created.data['id']));
            row['existingId'] = String(created.data['id']);
            row['expectedETag'] = String(created.etag);
        }
        const rewire = (rows) => { for (const list of Object.values(rows))
            for (const r of list)
                for (const [k, v] of Object.entries(r))
                    if (typeof v === 'string' && ids.has(v))
                        r[k] = ids.get(v); return rows; };
        rewire(sample);
        const data = Object.fromEntries(Object.entries(sample).filter(([k]) => k !== 'Control'));
        const clone = (x) => JSON.parse(JSON.stringify(x));
        await t.test('A1 difference of 0.01 is diagnosed and has zero effect', async () => {
            const off = clone(data);
            off['Apertura'].find(r => r['externalKey'] === 'equity1')['amount'] = '449.99';
            const s = await start(b, org2, 'OPENING', 'P05-OPEN-OFF', workbook('OPENING', 'P05-OPEN-OFF', off, { cutoffDate: control['cutoffDate'] }));
            const items = s.preview.data['items'].map(i => String(i['code']));
            CHECKS['A1'] = { canConfirm: s.preview.data['canConfirm'], errors: s.preview.data['errorCount'], codes: items, totals: s.preview.data['totals'], journals: (await raw(org2)).journals };
            assert.equal(s.preview.data['canConfirm'], false);
            assert.ok(items.includes('BALANCE_DIFFERENCE') || items.includes('IMPORT_NOT_BALANCED'), JSON.stringify(items));
            assert.equal((await raw(org2)).journals, 0);
        });
        let openingId = '';
        await t.test('A2 exact sample commits ONE journal 600 = 150 + 450 through the S3 bridge, no loan/income', async () => {
            const s = await start(b, org2, 'OPENING', 'P05-OPEN', workbook('OPENING', 'P05-OPEN', data, { cutoffDate: control['cutoffDate'] }));
            assert.equal(s.preview.data['canConfirm'], true, JSON.stringify(s.preview.data['items']));
            const totals = s.preview.data['totals'];
            CHECKS['A2-preview-totals'] = totals;
            assert.equal(totals['assets'], '600.00');
            const snapshot = s.preview.data['openingSnapshot'], native = f.runtime.opening;
            const created = await native.mutate(b.issued.context, 'createOpening', org2, { snapshot }, randomUUID());
            openingId = String(created.data['id']);
            const validated = await native.mutate(b.issued.context, 'validateOpening', org2, { policyVersion: 'S03-OPENING-0.1' }, randomUUID(), openingId, created.etag), validation = validated.data['validation'];
            const binding = { validationId: validation['id'], validationFingerprint: validation['fingerprint'] }, approved = await native.mutate(b.issued.context, 'approveOpening', org2, binding, randomUUID(), openingId, validated.etag);
            const commit = { ...binding, importBridge: { importId: s.ps.importId, previewId: s.preview.data['id'], semanticHash: s.preview.data['semanticHash'], openingId, validationId: validation['id'], openingFingerprint: validation['fingerprint'] } }, key = randomUUID();
            await f.proof(b, 'OPENING_COMMIT', { organizationId: org2, idempotencyKey: key, expectedETag: approved.etag, payload: commit }, openingId);
            assert.equal((await native.mutate(b.issued.context, 'commitOpening', org2, commit, key, openingId, approved.etag)).status, 201);
            const r = await raw(org2);
            ORACLE['opening-ledger'] = r;
            assert.equal(r.journals, 1);
            assert.equal(r.debit, '600.00');
            assert.equal(r.credit, '600.00');
            assert.deepEqual(r.byClass['ASSET'], { debit: '600.00', credit: '0.00' });
            assert.deepEqual(r.byClass['LIABILITY'], { debit: '0.00', credit: '150.00' });
            assert.deepEqual(r.byClass['EQUITY'], { debit: '0.00', credit: '450.00' });
            assert.equal(r.byClass['INCOME'], undefined, 'no income from historical principal');
            assert.equal(await f.runtime.lending.loans.countDocuments({ organizationId: org2 }), 0);
            assert.equal(await f.database.db.collection('loan_operation_books').countDocuments({ organizationId: org2 }), 0);
            assert.equal((await service.readImport(b.issued.context, s.ps, 'getBusinessImport')).data['state'], 'COMMITTED');
        });
        await t.test('A3 a second opening on the now-operated book is refused without effects', async () => {
            const s = await start(b, org2, 'OPENING', 'P05-OPEN-2', workbook('OPENING', 'P05-OPEN-2', data, { cutoffDate: control['cutoffDate'] }));
            const items = s.preview?.data['items']?.map(i => String(i['code'])) ?? [];
            let nativeRefusal = null;
            if (s.preview?.data['canConfirm'] === true) {
                try {
                    await f.runtime.opening.mutate(b.issued.context, 'createOpening', org2, { snapshot: s.preview.data['openingSnapshot'] }, randomUUID());
                }
                catch (e) {
                    nativeRefusal = code(e);
                }
            }
            CHECKS['A3'] = { state: s.current.data['state'], canConfirm: s.preview?.data['canConfirm'] ?? null, codes: items, nativeRefusal, journals: (await raw(org2)).journals };
            assert.ok(s.preview?.data['canConfirm'] === false || nativeRefusal !== null, JSON.stringify(CHECKS['A3']));
            assert.equal((await raw(org2)).journals, 1);
        });
        // ---------- B. Historical link: residual principal is not a disbursement/income; CJK borrower name vs PDF ----------
        await t.test('B historical origin adds no journal, PORTFOLIO principal = 200; PDF with CJK borrower name', async () => {
            const source = await f.runtime.opening.files.findOne({ _id: openingId });
            assert.ok(source?.commit);
            const principal = source.snapshot.components.find(c => c.category === 'PRINCIPAL_RECEIVABLE'), reference = source.snapshot.references.find(r => r.id === principal.referenceId), borrowerRef = source.snapshot.references.find(r => r.id === reference.borrowerId);
            const extra = async (c, k) => String((await f.runtime.finance.mutate(b.issued.context, 'createAccount', org2, { code: c, name: 'Cuenta P05 ' + c, accountClass: k, kind: 'GENERAL', currency: 'COP' }, randomUUID())).data['id']);
            const profile = { principalAccountId: principal.accountId, interestReceivableAccountId: await extra('P05_INT_RECV', 'ASSET'), interestIncomeAccountId: await extra('P05_INT_INC', 'INCOME'), borrowerCreditAccountId: await extra('P05_CREDIT', 'LIABILITY') }, versions = {};
            for (const role of Object.keys(profile))
                versions[role] = (await f.runtime.finance.read(b.issued.context, 'readAccount', org2, profile[role])).etag;
            const cutoff = control['cutoffDate'], debt = source.snapshot.components.find(c => c.category === 'LIABILITY');
            const obligations = [{ externalKey: 'DEBT', action: 'CREATE', kind: 'PRIVATE_DEBT', label: 'Deuda histórica P05', counterpartyReference: 'SYN-P05', principal: debt.amount,
                    rateJson: JSON.stringify({ kind: 'NONE_DECLARED', source: 'SYNTHETIC_DECLARED', sourceReference: 'SYN', validFrom: cutoff, observedOn: cutoff, unit: 'ANNUAL_FRACTION', convention: 'ANNUAL_SIMPLE_ACT_365', decimalValue: '0.00', combine: 'NONE' }),
                    scheduleJson: JSON.stringify({ kind: 'OFFICIAL_DECLARED', validFrom: cutoff, referenceDate: cutoff, sourceReference: 'SYN', principalOpening: debt.amount, rateVersionIds: [], installments: [{ number: 1, dueDate: today(f.now()), principal: debt.amount, interest: '0.00', insurance: '0.00', fees: '0.00', total: debt.amount }] }),
                    prepaymentPermissionsJson: '[]', supportReference: 'SYN', recognitionKind: 'EXISTING_JOURNAL_LINK', principalAccountKey: debt.accountId, openingId, openingComponentKey: debt.id, supportKeys: 'SYN' }];
            const rows = { Obligaciones: obligations, Prestatarios: [{ externalKey: 'BORROWER', action: 'CREATE', code: 'P05_HIST', displayName: 'Prestatario 李 P05', schemaVersion: 1, openingReferenceKey: borrowerRef.id, supportKeys: 'SYN' }],
                Prestamos: [{ externalKey: 'LOAN', action: 'HISTORICAL_DECLARED', borrowerKey: '@BORROWER', openingId, openingReferenceKey: reference.id, principalComponentKey: principal.id, originationDate: reference.originationDate, principalOutstanding: principal.amount, scheduleVersion: 1, supportKeys: 'SYN' }],
                Cuotas: [{ externalKey: 'Q1', loanKey: '@LOAN', scheduleVersion: 1, number: 1, dueDate: cutoff, principalRemaining: '200.00', recognizedInterestRemaining: '0.00', unrecognizedInterestRemaining: '0.00', supportKeys: 'SYN' }],
                Soportes: [{ externalKey: 'SYN', reference: 'SYN-P05-RESIDUAL', asOfDate: cutoff, declaration: 'DECLARED' }] };
            const before = await raw(org2);
            const s = await start(b, org2, 'HISTORICAL_LINK', 'P05-HIST', workbook('HISTORICAL_LINK', 'P05-HIST', rows, { cutoffDate: cutoff, openingId }), { historicalProfiles: [{ externalKey: 'LOAN', accountProfile: profile, accountVersions: versions }] });
            assert.equal(s.preview.data['canConfirm'], true, JSON.stringify(s.preview.data['items']));
            const c = await confirm(b, org2, s), receipt = await c.run();
            assert.equal(receipt.status, 201);
            const after = await raw(org2);
            ORACLE['historical-ledger'] = { before, after, receiptJournalIds: receipt.data['journalIds'], receiptTotals: receipt.data['totals'] };
            assert.deepEqual(receipt.data['journalIds'], []);
            assert.deepEqual(after, before, 'historical link must not post');
            assert.equal(await f.runtime.lending.loans.countDocuments({ organizationId: org2 }), 0, 'no synthetic S4 loan/disbursement');
            f.clock.value += 1000;
            const date = today(f.now()), p = { organizationId: org2, reportKind: 'PORTFOLIO' };
            const snap = await service.report(b.issued.context, p, { asOf: date, from: date, to: date }), token = snap.data['meta']['snapshotToken'];
            const page = await service.reportPage(b.issued.context, p, { snapshotToken: token }), total = page.data['totals'].find(x => x['columnId'] === 'principal');
            ORACLE['portfolio'] = { totalRows: page.data['totalRows'], principal: total['value'] };
            assert.equal(total['value'], '200.00');
            const outcome = {};
            for (const format of ['CSV', 'PDF']) {
                try {
                    const e = await service.createExport(b.issued.context, { organizationId: org2 }, { reportKind: 'PORTFOLIO', snapshotToken: token, format }, randomUUID());
                    outcome[format] = { state: e.data['state'] };
                }
                catch (e) {
                    outcome[format] = { error: code(e), status: e.status };
                }
            }
            CHECKS['B-export-cjk-borrower'] = outcome;
        });
        // ---------- C. OPERATIVE idempotency, repack, mapping change, concurrency, response loss ----------
        const org = f.org, a = f.a, count = async () => await accounts.countDocuments({ organizationId: org }), cat = (rows) => ({ Cuentas: rows.map(r => ({ externalKey: r.k, action: 'CREATE', code: r.code, name: r.name, accountClass: 'ASSET', kind: 'BANK', currency: 'COP' })) });
        await t.test('C idempotent confirm, repack coalescing, mapping/content change, concurrent keys, lost response', async () => {
            const base = await count(), book1 = workbook('OPERATIVE', 'P05-CAT', cat([{ k: 'A', code: 'P05_A', name: 'Banco A P05' }, { k: 'B', code: 'P05_B', name: 'Banco B P05' }]));
            const s1 = await start(a, org, 'OPERATIVE', 'P05-CAT', book1);
            assert.equal(s1.preview.data['canConfirm'], true);
            const c1 = await confirm(a, org, s1), r1 = await c1.run();
            assert.equal(r1.status, 201);
            assert.equal(await count(), base + 2);
            const replay = await c1.run();
            assert.equal(replay.status, 200);
            assert.deepEqual(replay.data, r1.data);
            assert.equal(await count(), base + 2);
            let conflict = null;
            try {
                await service.confirm(a.issued.context, s1.ps, { ...c1.payload, bookETag: '"other"' }, c1.key, s1.current.etag);
            }
            catch (e) {
                conflict = code(e);
            }
            // Repackaged: same rows, STORE method and reversed entry order -> different physical SHA.
            const book2 = workbook('OPERATIVE', 'P05-CAT', cat([{ k: 'A', code: 'P05_A', name: 'Banco A P05' }, { k: 'B', code: 'P05_B', name: 'Banco B P05' }]), {}, { store: true, reverse: true });
            assert.notEqual(Buffer.compare(book1, book2), 0);
            const s2 = await start(a, org, 'OPERATIVE', 'P05-CAT', book2);
            // Mapping change and one-cell content change under the same namespace/keys.
            let mapping = null;
            const s3 = await start(a, org, 'OPERATIVE', 'P05-CAT', workbook('OPERATIVE', 'P05-CAT', cat([{ k: 'A', code: 'P05_A', name: 'Banco A P05' }]), { mappingVersion: 'S11-MAP-2' })).catch(e => { mapping = code(e); return null; });
            const s4 = await start(a, org, 'OPERATIVE', 'P05-CAT', workbook('OPERATIVE', 'P05-CAT', cat([{ k: 'A', code: 'P05_A', name: 'Banco A P05' }, { k: 'B', code: 'P05_B', name: 'Banco B P05 cambiado' }])));
            let s4confirm = null;
            if (s4.preview?.data['canConfirm'] === true) {
                try {
                    await (await confirm(a, org, s4)).run();
                }
                catch (e) {
                    s4confirm = code(e);
                }
            }
            CHECKS['C1'] = { replayEqual: true, sameKeyOtherBody: conflict, repack: { state: s2.current.data['state'], duplicateOf: s2.current.data['duplicateOf'] ?? null, jobResource: s2.job.data['resourceId'] ?? null, physicalDiffers: true },
                mapping: mapping ?? { canConfirm: s3?.preview?.data['canConfirm'], codes: s3?.preview?.data['items']?.map(i => i['code']) },
                changedCell: { canConfirm: s4.preview?.data['canConfirm'], codes: s4.preview?.data['items']?.map(i => i['code']), confirm: s4confirm }, accounts: (await count()) - base };
            assert.equal(conflict, 'IDEMPOTENCY_CONFLICT');
            assert.equal(s2.current.data['state'], 'CANCELLED', 'repack of committed content must coalesce, not stage a second effect');
            assert.ok(mapping !== null || s3?.preview?.data['canConfirm'] === false, 'unknown mappingVersion must not be confirmable');
            assert.ok(s4.preview?.data['canConfirm'] === false || s4confirm !== null, 'CREATE with an already registered key must not create again');
            assert.equal(await count(), base + 2);
            // Two concurrent confirmations of one READY import with different keys: one effect.
            const s5 = await start(a, org, 'OPERATIVE', 'P05-CAT2', workbook('OPERATIVE', 'P05-CAT2', cat([{ k: 'C', code: 'P05_C', name: 'Banco C P05' }])));
            const k1 = await confirm(a, org, s5), k2 = await confirm(a, org, s5), both = await Promise.allSettled([k1.run(), k2.run()]);
            CHECKS['C2-concurrent'] = both.map(x => x.status === 'fulfilled' ? { status: x.value.status } : { error: code(x.reason) });
            assert.equal(both.filter(x => x.status === 'fulfilled').length, 1, JSON.stringify(CHECKS['C2-concurrent']));
            assert.equal(await count(), base + 3);
            // Lost response: commit, drop the result, recover through GET receipt then retry the SAME key.
            const s6 = await start(a, org, 'OPERATIVE', 'P05-CAT3', workbook('OPERATIVE', 'P05-CAT3', cat([{ k: 'D', code: 'P05_D', name: 'Banco D P05' }])));
            const k6 = await confirm(a, org, s6);
            await k6.run();
            const recovered = await service.readImport(a.issued.context, s6.ps, 'getBusinessImportReceipt'), retried = await k6.run();
            CHECKS['C3-lost-response'] = { retryStatus: retried.status, same: JSON.stringify(recovered.data) === JSON.stringify(retried.data) };
            assert.equal(retried.status, 200);
            assert.equal(recovered.data['id'], retried.data['id']);
            assert.equal(await count(), base + 4);
            let newKey = null;
            try {
                await (await confirm(a, org, s6)).run();
            }
            catch (e) {
                newKey = code(e);
            }
            CHECKS['C3-new-key-after-commit'] = newKey;
            assert.notEqual(newKey, null);
            assert.equal(await count(), base + 4);
        });
        // ---------- D. 200M = 80M cash + 120M direct debt with 20M protected reserve; file cannot bypass the reserve ----------
        await t.test('D 200M purchase by file: one journal, no fictitious cash/income, reserve intact; over-free variant rejected with zero effect', async () => {
            const date = today(f.now()), p = { organizationId: org }, tag = async () => String((await f.wealthRead('businessGetWealthBook', p)).etag);
            const capital = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN-P05', description: 'Capital P05', lines: [{ accountId: f.bank.id, debit: '80000000.00', credit: '0.00' }, { accountId: f.equity.id, debit: '0.00', credit: '80000000.00' }] }, ck = randomUUID();
            await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: ck, payload: capital });
            await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, capital, ck);
            const fund = await f.wealthMutate('businessCreateFund', { mode: 'VIRTUAL', label: 'Reserva P05', purpose: 'ASSET_PURCHASE', backingAccountId: f.bank.id, supportReference: 'SYN-P05' }, p), fundId = String(fund.data['id']);
            await f.wealthMutate('businessAllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '20000000.00', supportReference: 'SYN-P05' }, { ...p, fundId }, fund.etag);
            const property = await f.account('P05_PROPERTY'), mortgage = await f.account('P05_MORTGAGE', 'LIABILITY');
            const draft = await f.wealthMutate('businessCreateAssetDraft', { assetClass: 'APARTMENT', otherClassDescription: null, label: 'Apartamento P05', origin: 'PURCHASE', legalOwnerReference: 'SYN-P05', ownershipPercentage: '100.00', grossCostDeclared: '200000000.00', assetAccountId: property.id, supportReferences: ['SYN-P05'], locationGeneral: null }, p), assetId = String(draft.data['id']);
            const wealth = readSample(TEMPLATES + 'wealth-200m.xlsx');
            const variant = async (cash, debt) => {
                const w = JSON.parse(JSON.stringify(wealth)), acquire = w['Operaciones'][0], valuation = w['Operaciones'][1], cmd = JSON.parse(String(acquire['commandJson'])), funding = cmd['funding'];
                cmd['bookETag'] = await tag();
                cmd['effectiveDate'] = date;
                funding[0]['accountId'] = f.bank.id;
                funding[0]['amount'] = cash;
                funding[1]['principalAccountId'] = mortgage.id;
                funding[1]['amount'] = debt;
                const def = funding[1]['liabilityDefinition'];
                def['principal'] = debt;
                def['schedule']['principalOpening'] = debt;
                def['schedule']['installments'][0]['principal'] = debt;
                def['schedule']['installments'][0]['total'] = debt;
                acquire['entityKey'] = assetId;
                acquire['expectedETag'] = String(draft.etag);
                acquire['effectiveDate'] = date;
                acquire['commandJson'] = JSON.stringify(cmd);
                const v = JSON.parse(String(valuation['commandJson']));
                v['valuationDate'] = date;
                valuation['entityKey'] = assetId;
                valuation['effectiveDate'] = date;
                valuation['commandJson'] = JSON.stringify(v);
                w['Fuentes'].forEach((r, i) => { r['assetKey'] = assetId; r['accountKey'] = i === 0 ? f.bank.id : mortgage.id; r['amount'] = i === 0 ? cash : debt; });
                return { Operaciones: w['Operaciones'], Fuentes: w['Fuentes'], Soportes: w['Soportes'] };
            };
            const snapshotState = async () => ({ ledger: await raw(org), asset: (await f.wealthRead('businessGetAsset', { ...p, assetId })).data['state'], reserved: (await f.wealthRead('businessGetFund', { ...p, fundId })).data['reserved'] });
            // Negative first: 90M from the account exceeds the 80M free balance (20M reserved).
            const before = await snapshotState();
            let negative = {};
            try {
                const s = await start(a, org, 'OPERATIVE', 'P05-W-OVER', workbook('OPERATIVE', 'P05-W-OVER', await variant('90000000.00', '110000000.00')));
                negative = { canConfirm: s.preview?.data['canConfirm'], codes: s.preview?.data['items']?.map(i => i['code']) };
                if (s.preview?.data['canConfirm'] === true) {
                    try {
                        await (await confirm(a, org, s)).run();
                        negative['confirm'] = 'ACCEPTED';
                    }
                    catch (e) {
                        negative['confirm'] = code(e);
                    }
                }
            }
            catch (e) {
                negative['error'] = code(e);
            }
            const afterNegative = await snapshotState();
            CHECKS['D-over-free'] = { negative, before, afterNegative };
            assert.notEqual(negative['confirm'], 'ACCEPTED', 'file must not spend reserved cash');
            assert.deepEqual(afterNegative, before);
            // Positive: 80M cash (exactly the free balance) + 120M new direct debt.
            const s = await start(a, org, 'OPERATIVE', 'P05-W-200M', workbook('OPERATIVE', 'P05-W-200M', await variant('80000000.00', '120000000.00')));
            assert.equal(s.preview.data['canConfirm'], true, JSON.stringify(s.preview.data['items']));
            const receipt = await (await confirm(a, org, s)).run();
            assert.equal(receipt.status, 201);
            const after = await raw(org), newJournals = after.journals - before.ledger.journals;
            const assetView = (await f.wealthRead('businessGetAsset', { ...p, assetId })).data, fundView = (await f.wealthRead('businessGetFund', { ...p, fundId })).data;
            const availability = (await f.wealthRead('businessGetWealthAvailability', p, { asOf: date, accountId: f.bank.id })).data;
            const oracle = { bankRaw: await balanceOf(org, f.bank.id), propertyRaw: await balanceOf(org, property.id), mortgageRaw: await balanceOf(org, mortgage.id), indicativeEquity: money(cents('220000000.00') - cents('120000000.00')) };
            ORACLE['wealth-200m'] = { oracle, newJournals, ledger: after, asset: { recognizedCost: assetView['recognizedCost'], ownedEstimatedValue: assetView['ownedEstimatedValue'], linkedPrincipal: assetView['linkedPrincipal'], indicativeEquity: assetView['indicativeEquity'] }, reserved: fundView['reserved'], availability };
            assert.equal(newJournals, 1, 'acquisition = one journal; valuation 220M posts nothing');
            assert.equal(oracle.bankRaw, '20000000.00');
            assert.equal(oracle.propertyRaw, '200000000.00');
            assert.equal(oracle.mortgageRaw, '-120000000.00');
            assert.equal(after.byClass['INCOME'], undefined, 'liability is not income');
            assert.equal(fundView['reserved'], '20000000.00');
            assert.equal(availability['free'], '0.00');
            assert.equal(assetView['recognizedCost'], '200000000.00');
            assert.equal(assetView['ownedEstimatedValue'], '220000000.00');
            assert.equal(assetView['indicativeEquity'], oracle.indicativeEquity);
        });
    }
    finally {
        await group.dispose();
        writeFileSync('../../Construccion/Sprints/S11/Evidencias/S11-P05-CHECKS-ECONOMY.json', JSON.stringify({ task: 'S11-P05', suite: 'economy', runId: group.runId, at: new Date().toISOString(), checks: CHECKS, oracle: ORACLE }, null, 1) + '\n');
    }
});
//# sourceMappingURL=economy.test.js.map