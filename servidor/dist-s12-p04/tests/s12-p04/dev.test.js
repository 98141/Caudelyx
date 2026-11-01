/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered P02 UUID controls and own child handles, no user-derived paths. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { s12Profile } from './fixture.js';
import { definition } from './oracle.js';
const { writeOwn, mkdirOwn, projectRoot } = await import(new URL('../../../scripts/s12-p04-guard.mjs', import.meta.url).href);
const writeFile = async (p, d, o) => { await writeOwn(p, d, projectRoot, o); };
const mkdir = async (p) => { await mkdirOwn(p); };
const copyFile = async (a, b) => { await writeOwn(b, await readFile(a)); };
const evidence = resolve('../../Construccion/Sprints/S12/Evidencias');
async function port() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const a = s.address(); assert.ok(a && typeof a !== 'string'); await new Promise(r => s.close(() => r())); assert.ok(![27017, 27181, 3001, 3002, 4001].includes(a.port)); return a.port; }
test('npm run dev uses owned S12 profile; HTTPS, scenario state survives two orderly starts', { timeout: 240000 }, async () => {
    const group = await s12Profile();
    let child;
    let log = '';
    const cycles = [];
    try {
        const f = await group.fixture(), a = await f.actor(), org = (await f.runtime.organizations.create(a.issued.context, { name: 'npm sintético P02', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
        await f.restore.flush();
        await f.database.close();
        const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8'));
        const encoded = { version: 2, mail: f.keys.mail.toString('base64url'), totp: f.keys.totp.toString('base64url'), journal: f.keys.journal.toString('base64url'), cursor: f.keys.cursor.toString('base64url'), priority: f.keys.priority.toString('base64url') };
        await writeFile(join(group.folder, 'keys.json'), JSON.stringify(encoded), { flag: 'wx', mode: 0o600 });
        await mkdir(join(group.folder, 'tls'));
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(group.folder, 'key.pem'), '-out', join(group.folder, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'], { windowsHide: true });
        await copyFile(join(group.folder, 'key.pem'), join(group.folder, 'tls/key.pem'));
        await copyFile(join(group.folder, 'cert.pem'), join(group.folder, 'tls/cert.pem'));
        const originalKeys = createHash('sha256').update(await readFile(join(group.folder, 'keys.json'))).digest('hex'), ui = await port(), api = await port(), platform = await port(), cert = await readFile(join(group.folder, 'cert.pem')), basePath = '/api/v1/organizations/' + org + '/simulation-s12';
        let csrf = '', id = '', etag = '';
        const call = async (method, path, body, contentType = 'application/json', headers = {}) => await new Promise((done, reject) => {
            const req = request({ hostname: '127.0.0.1', port: api, servername: 'localhost', ca: cert, path, method, headers: { Host: 'localhost:' + ui, Origin: 'https://localhost:' + ui, Cookie: '__Host-caudelyx-session=' + a.issued.token, 'X-CSRF-Token': csrf, 'Content-Type': contentType, ...headers } }, res => { const chunks = []; res.on('data', b => chunks.push(Buffer.from(b))); res.on('end', () => { try {
                done({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), etag: String(res.headers.etag ?? '') });
            }
            catch (e) {
                reject(e);
            } }); });
            req.on('error', reject);
            if (body)
                req.write(body);
            req.end();
        });
        for (let cycle = 0; cycle < 2; cycle++) {
            const start = performance.now();
            log = '';
            const env = { ...process.env, CAUDELYX_MODE: 'local-synthetic', MONGODB_URI: group.uri, MONGODB_DATABASE: group.names[0], CAUDELYX_DEV_TEST_ID: owner.id, CAUDELYX_DEV_BUILD_SCOPE: 'S12-P04', CAUDELYX_S12_OWNER_PID: String(process.pid), CAUDELYX_S12_OWNER_NONCE: owner.nonce, CAUDELYX_DEV_UI_PORT: String(ui), CAUDELYX_DEV_API_PORT: String(api), CAUDELYX_DEV_PLATFORM_PORT: String(platform), CAUDELYX_DEV_SMOKE: '1' };
            child = spawn(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'run', 'dev'], { cwd: resolve('..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', b => { log += String(b); });
            child.stderr.on('data', b => { log += String(b); });
            const ended = once(child, 'exit');
            const deadline = Date.now() + 100000;
            while (!log.includes('S02 LOCAL SINTÉTICO:')) {
                if (child.exitCode !== null || Date.now() > deadline)
                    throw Error('Owned npm start failed: ' + log.slice(-2000));
                await new Promise(r => setTimeout(r, 200));
            }
            assert.equal((await call('GET', basePath + '/policy')).status, 200);
            const token = await call('GET', '/api/v1/auth/csrf');
            assert.equal(token.status, 200);
            csrf = String(token.data['data']['csrfToken']);
            if (cycle === 0) {
                const base = await call('POST', basePath + '/bases', Buffer.from(JSON.stringify({ asOf: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now()), currency: 'COP' })), 'application/json', { 'Idempotency-Key': randomUUID() });
                assert.equal(base.status, 201, JSON.stringify(base));
                const b = base.data['data'];
                const created = await call('POST', basePath + '/scenarios', Buffer.from(JSON.stringify({ name: 'Escenario reiniciado S12', ...definition(), baseId: b['id'], baseToken: b['baseToken'] })), 'application/json', { 'Idempotency-Key': randomUUID() });
                assert.equal(created.status, 201, JSON.stringify(created));
                id = String(created.data['data']['id']);
                etag = created.etag;
            }
            else {
                const state = await call('GET', basePath + '/scenarios/' + id);
                assert.equal(state.status, 200, JSON.stringify(state));
                assert.equal(state.data['data']['name'], 'Escenario reiniciado S12');
                assert.equal(state.etag, etag);
            }
            await writeFile(join(group.folder, 's12-smoke.done'), 'OWN_P02_DONE', { flag: 'wx' });
            const [code] = await ended;
            assert.equal(code, 0, log.slice(-3000));
            child = undefined;
            await unlink(join(group.folder, 's12-smoke.done'));
            assert.equal(createHash('sha256').update(await readFile(join(group.folder, 'keys.json'))).digest('hex'), originalKeys);
            cycles.push({ cycle: cycle + 1, argv: 'npm run dev', durationMs: performance.now() - start, source: 'current reserved live code', log });
        }
        await writeFile(join(evidence, 'S12-P04-DEV.json'), JSON.stringify({ result: 'PASS', runId: group.runId, cycles, scenarioId: id, keysUnchanged: true, persistentProfilesTouched: false }, null, 2) + '\n');
    }
    finally {
        if (child && child.exitCode === null) {
            await writeFile(join(group.folder, 's12-smoke.done'), 'OWN_P02_FINALIZE').catch(() => undefined);
            await once(child, 'exit').catch(() => undefined);
        }
        await group.dispose();
    }
});
//# sourceMappingURL=dev.test.js.map