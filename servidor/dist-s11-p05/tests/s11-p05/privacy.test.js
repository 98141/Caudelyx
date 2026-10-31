// S11-P05 (Claude): authorization/privacy review on ONE own Mongo group. Unique markers are seeded in labels, account names and
// workbook cells; every foreign response AND error is serialized and searched for them (not just the HTTP status).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { s11Profile, world } from './profile.js';
import { workbook } from './book.js';
import { today } from '../../src/modules/obligations/calendar.js';
const CHECKS = {};
test('S11-P05 privacy: foreign T, collaborator, PERSONAL owner and suspended member see nothing; markers never leak', { timeout: 600000 }, async (t) => {
    const group = await s11Profile();
    try {
        const f = await world(group, Date.parse('2026-10-31T12:00:00-05:00')), service = f.identity.exchange, a = f.a, org = f.org;
        const MARK = 'P05MARK' + randomUUID().replace(/-/g, '').slice(0, 12), PMARK = 'P05PRIV' + randomUUID().replace(/-/g, '').slice(0, 12);
        const seen = [];
        const attempt = async (who, call, fn) => {
            f.clock.value += 7000;
            try {
                const r = await fn();
                const o = { ok: true, value: r };
                seen.push({ who, call, outcome: o });
                return o;
            }
            catch (e) {
                const x = e;
                const o = { ok: false, code: x.code ?? null, status: x.status ?? null, message: String(x.message ?? '') };
                seen.push({ who, call, outcome: o });
                return o;
            }
        };
        const date = () => today(f.now());
        // T (owner) prepares an import with markers and an export.
        const p = { organizationId: org }, created = await service.createImport(a.issued.context, 'createBusinessImport', { label: 'Etiqueta ' + MARK, mode: 'OPERATIVE', namespace: 'NS-' + MARK, templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, p, randomUUID());
        const ps = { ...p, importId: String(created.data['id']) }, up = await service.upload(a.issued.context, ps, randomUUID(), created.etag, workbook('OPERATIVE', 'NS-' + MARK, { Cuentas: [{ externalKey: 'K' + MARK, action: 'CREATE', code: 'C' + MARK.slice(-8), name: 'Nombre ' + MARK, accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }] }));
        const pv = await service.preparePreview(a.issued.context, ps, randomUUID(), up.etag);
        assert.equal(pv.data['state'], 'SUCCEEDED');
        f.clock.value += 61000;
        const snap = await service.report(a.issued.context, { ...p, reportKind: 'CASH' }, { asOf: date(), from: date(), to: date() }), token = String(snap.data['meta']['snapshotToken']);
        const exp = await service.createExport(a.issued.context, p, { reportKind: 'CASH', snapshotToken: token, format: 'CSV' }, randomUUID()), es = { ...p, exportId: String(exp.data['id']) }, jobId = String(exp.data['jobId']);
        const ownDownload = await service.download(a.issued.context, es, randomUUID(), false, exp.etag);
        assert.ok(ownDownload.bytes.toString('utf8').includes(f.bank.id), 'positive control: own export contains own account id');
        const BANK = f.bank.id;
        await t.test('foreign T of another org: 403/404 on every import/export/job/download path, no marker', async () => {
            const x = await f.actor(), org2 = (await f.runtime.organizations.create(x.issued.context, { name: 'Ajena P05', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id, mine = { organizationId: org2 };
            const outs = [
                await attempt('foreignT', 'getImport(victimOrg)', () => service.readImport(x.issued.context, ps, 'getBusinessImport')),
                await attempt('foreignT', 'getImport(ownOrg,victimId)', () => service.readImport(x.issued.context, { ...mine, importId: ps.importId }, 'getBusinessImport')),
                await attempt('foreignT', 'getPreview(ownOrg,victimId)', () => service.readImport(x.issued.context, { ...mine, importId: ps.importId }, 'getBusinessImportPreview')),
                await attempt('foreignT', 'getReceipt(ownOrg,victimId)', () => service.readImport(x.issued.context, { ...mine, importId: ps.importId }, 'getBusinessImportReceipt')),
                await attempt('foreignT', 'listImports(ownOrg)', () => service.readImport(x.issued.context, mine, 'listBusinessImports')),
                await attempt('foreignT', 'cancelImport(ownOrg,victimId)', () => service.cancelImport(x.issued.context, { ...mine, importId: ps.importId }, randomUUID(), String(up.etag))),
                await attempt('foreignT', 'getExport(ownOrg,victimId)', () => service.readExport(x.issued.context, { ...mine, exportId: es.exportId }, 'getBusinessExport')),
                await attempt('foreignT', 'listExports(ownOrg)', () => service.readExport(x.issued.context, mine, 'listBusinessExports')),
                await attempt('foreignT', 'download(ownOrg,victimId)', () => service.download(x.issued.context, { ...mine, exportId: es.exportId }, randomUUID(), false, exp.etag)),
                await attempt('foreignT', 'download(victimOrg)', () => service.download(x.issued.context, es, randomUUID(), false, exp.etag)),
                await attempt('foreignT', 'job(ownOrg,victimJob)', () => service.job(x.issued.context, { ...mine, jobId })),
                await attempt('foreignT', 'reportPage(victim token)', () => service.reportPage(x.issued.context, { ...mine, reportKind: 'CASH' }, { snapshotToken: token })),
                await attempt('foreignT', 'createExport(victim token)', () => service.createExport(x.issued.context, mine, { reportKind: 'CASH', snapshotToken: token, format: 'CSV' }, randomUUID())),
            ];
            const lists = outs.filter(o => o.ok);
            CHECKS['foreignT'] = seen.filter(s => s.who === 'foreignT').map(s => ({ call: s.call, outcome: s.outcome && s.outcome.ok ? { ok: true, totalRows: (s.outcome.value.data['totalRows']) } : s.outcome }));
            for (const l of lists)
                assert.equal(l.value.data['totalRows'], 0, 'only own empty lists may succeed');
            assert.equal(outs.filter(o => !o.ok).length, outs.length - lists.length);
        });
        await t.test('collaborator C in the same org cannot import, see T import/export or reuse T token', async () => {
            const c = await f.actor(), invite = { email: c.email, roleIds: ['C'] };
            await f.proof(a, 'MEMBER_INVITE', invite, org);
            await f.runtime.organizations.invite(a.issued.context, invite);
            await f.identity.dispatchMail();
            const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === c.email);
            await f.runtime.organizations.accept(c.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
            await attempt('C', 'createImport', () => service.createImport(c.issued.context, 'createBusinessImport', { label: 'C', mode: 'OPERATIVE', namespace: 'C-NS', templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, p, randomUUID()));
            await attempt('C', 'getImport', () => service.readImport(c.issued.context, ps, 'getBusinessImport'));
            await attempt('C', 'getPreview', () => service.readImport(c.issued.context, ps, 'getBusinessImportPreview'));
            await attempt('C', 'getExport(T)', () => service.readExport(c.issued.context, es, 'getBusinessExport'));
            await attempt('C', 'download(T)', () => service.download(c.issued.context, es, randomUUID(), false, exp.etag));
            await attempt('C', 'listExports', () => service.readExport(c.issued.context, p, 'listBusinessExports'));
            await attempt('C', 'reportPage(T token)', () => service.reportPage(c.issued.context, { ...p, reportKind: 'CASH' }, { snapshotToken: token }));
            await attempt('C', 'report NET_WORTH', () => service.report(c.issued.context, { ...p, reportKind: 'NET_WORTH' }, { asOf: date(), from: date(), to: date() }));
            const mine = seen.filter(s => s.who === 'C');
            CHECKS['C'] = mine;
            const okCalls = mine.filter(s => s.outcome.ok);
            assert.deepEqual(okCalls.map(s => s.call), ['listExports'], 'only own (empty) export list may succeed');
            assert.equal((okCalls[0].outcome.value.data['totalRows']), 0);
        });
        await t.test('PERSONAL import of another person is invisible to T; consolidated without FULL 100% declaration is denied', async () => {
            const bP = await f.actor();
            await f.runtime.organizations.create(bP.issued.context, { name: 'Org de B P05', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
            const book = (await f.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), bP)).data, pp = { bookId: book.id };
            const pc = await service.createImport(bP.issued.context, 'createPersonalImport', { label: 'Privado ' + PMARK, mode: 'INFORMATIONAL', namespace: 'NS-' + PMARK, templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, pp, randomUUID());
            const pps = { ...pp, importId: String(pc.data['id']) };
            await attempt('T-on-personal', 'getPersonalImport', () => service.readImport(a.issued.context, pps, 'getPersonalImport'));
            await attempt('T-on-personal', 'listPersonalImports', () => service.readImport(a.issued.context, pp, 'listPersonalImports'));
            await attempt('T-on-personal', 'personal report', () => service.report(a.issued.context, { ...pp, reportKind: 'NET_WORTH' }, { asOf: date(), from: date(), to: date() }));
            await attempt('T-consolidated', 'CONSOLIDATED_SUMMARY w/o declaration', () => service.report(a.issued.context, { bookId: f.book.id, reportKind: 'CONSOLIDATED_SUMMARY' }, { asOf: date(), from: date(), to: date() }, true));
            const mine = seen.filter(s => s.who.startsWith('T-'));
            CHECKS['personal'] = mine;
            for (const s of mine)
                assert.equal(s.outcome.ok, false, s.call);
            assert.equal(mine.at(-1).outcome.status, 403);
        });
        await t.test('member O: own export downloads; after SUSPEND by T the prepared export and its token are denied', async () => {
            const m = await f.actor(), invite = { email: m.email, roleIds: ['O'] };
            await f.proof(a, 'MEMBER_INVITE', invite, org);
            await f.runtime.organizations.invite(a.issued.context, invite);
            await f.identity.dispatchMail();
            const mail = [...f.messages.notificationInbox.values()].find(x => x.kind === 'INVITATION' && x.payload['email'] === m.email);
            await f.runtime.organizations.accept(m.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
            f.clock.value += 61000;
            const ms = await service.report(m.issued.context, { ...p, reportKind: 'CASH' }, { asOf: date(), from: date(), to: date() }), mt = String(ms.data['meta']['snapshotToken']);
            const me = await service.createExport(m.issued.context, p, { reportKind: 'CASH', snapshotToken: mt, format: 'XLSX' }, randomUUID()), mes = { ...p, exportId: String(me.data['id']) };
            const before = await attempt('O-before', 'download own', () => service.download(m.issued.context, mes, randomUUID(), false, me.etag));
            const subject = m.issued.context.subjectId, target = await f.identity.identities.findOne({ _id: subject });
            await f.proof(a, 'MEMBER_SUSPEND', undefined, subject);
            await f.runtime.organizations.memberCommand(a.issued.context, subject, 'SUSPEND', String(target.version));
            const after = await attempt('O-after', 'download after suspend', () => service.download(m.issued.context, mes, randomUUID(), false, me.etag));
            const page = await attempt('O-after', 'reportPage after suspend', () => service.reportPage(m.issued.context, { ...p, reportKind: 'CASH' }, { snapshotToken: mt }));
            CHECKS['O-suspend'] = { before: before.ok, after, page };
            assert.equal(before.ok, true);
            assert.equal(after.ok, false);
            assert.equal(page.ok, false);
        });
        await t.test('no foreign response or error contains a marker, account id or private label', async () => {
            const foreign = seen.filter(s => !['O-before'].includes(s.who)), blob = JSON.stringify(foreign);
            CHECKS['markerSearch'] = { responses: foreign.length, MARK: blob.includes(MARK), PMARK: blob.includes(PMARK), bankId: blob.includes(BANK), victimImportId: blob.includes(ps.importId) };
            assert.equal(blob.includes(MARK), false);
            assert.equal(blob.includes(PMARK), false);
            assert.equal(blob.includes(BANK), false);
            const codes = foreign.map(s => s.outcome.status).filter(Boolean);
            CHECKS['statusSet'] = [...new Set(codes)];
        });
    }
    finally {
        await group.dispose();
        writeFileSync('../../Construccion/Sprints/S11/Evidencias/S11-P05-CHECKS-PRIVACY.json', JSON.stringify({ task: 'S11-P05', suite: 'privacy', runId: group.runId, at: new Date().toISOString(), checks: CHECKS }, null, 1) + '\n');
    }
});
//# sourceMappingURL=privacy.test.js.map