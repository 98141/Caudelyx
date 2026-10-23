/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Only this review's own reserved control directory (validated runId) and its files; keys are fixed test labels. */
// S02-P05 independent environment checks (Claude): the REAL root launcher (Caudelyx/scripts/dev.mjs -> installed-dev.mjs) in the
// reserved test profile (CAUDELYX_DEV_TEST_ID, ports 5331/5431/5332) on the owner's Mongo 27017/rs0, never caudelyx_dev/manual.
// Mailbox output (activation codes/links) stays in memory; evidence records only booleans/statuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { request } from 'node:https';
import { pathToFileURL } from 'node:url';
import { localTestProfile } from '../../helpers/local-test-profile.js';
import { ApiClient } from '../../helpers/client.js';

/** Same wire behaviour as the Vite proxy: TLS to the API port, Host/Origin of the tenant UI origin (localhost:5331). */
class OriginClient extends ApiClient {
  override async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return await super.call(method, path, body, { Host: 'localhost:5331', Origin: 'https://localhost:5331', ...headers });
  }
}

const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const serverRoot = resolve(import.meta.dirname, '../../../..'), projectRoot = resolve(serverRoot, '..');
const RUN = process.env['CAUDELYX_TEST_RUN_ID'] ?? '';
const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_ID: RUN, CAUDELYX_DEV_UI_PORT: '5331', CAUDELYX_DEV_API_PORT: '5431', CAUDELYX_DEV_PLATFORM_PORT: '5332' };
  for (const k of ['MONGODB_URI', 'MONGODB_DATABASE', 'CAUDELYX_DEV_SMOKE']) delete e[k];
  return e;
};
interface Profile { installedSettings(env: NodeJS.ProcessEnv): { database: string; control: string }; validateInstalledUri(v: string): URL; inspectInstalled(s: { mongoUri: string }): Promise<{ replicaSet: string }> }

async function launch() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: projectRoot, env: env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; for (const s of [child.stdout, child.stderr]) s?.on('data', d => { output += String(d); });
  const outcome = await new Promise<'ready' | 'exited'>(done => {
    const timer = setTimeout(() => done('exited'), 90000);
    child.on('message', m => { if (m === 'S02_INSTALLED_READY') { clearTimeout(timer); done('ready'); } });
    child.once('exit', () => { clearTimeout(timer); done('exited'); });
  });
  return { child, outcome, output: () => output };
}
async function shutdown(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  const ended = once(child, 'exit'); child.send('LOCAL_DEV_STOP');
  const timer = setTimeout(() => child.kill(), 30000);
  try { const [code] = await ended; return code as number; } finally { clearTimeout(timer); }
}
const get = (url: string, ca: Buffer) => new Promise<number>(done => {
  const req = request(url, { ca, servername: 'localhost', timeout: 5000 }, res => { res.resume(); res.once('end', () => done(res.statusCode ?? 0)); });
  req.on('error', () => done(-1)); req.on('timeout', () => req.destroy()); req.end();
});
async function mailbox(email: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['servidor/scripts/mailbox-installed.mjs', '--email', email], { cwd: projectRoot, env: { ...env(), ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout?.on('data', d => { out += String(d); }); child.stderr?.on('data', d => { err += String(d); });
  const [code] = await once(child, 'exit');
  return { code: code as number, messages: code === 0 ? (JSON.parse(out) as { messages: { purpose: string; code: string; activationUrl?: string; requiresPasswordSetup?: boolean }[] }).messages : [], denied: err.includes('Buzón denegado') };
}
const sha = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');

test('P05-ENV-01 installed profile guards (pure validation + Mongo hello only): remote/credential/other-port/extra-option URIs, other databases, bad test ids/ports/mode, wrong replicaSet name — clear errors, no fallback', { timeout: 60000 }, async () => {
  const p = await import(pathToFileURL(join(serverRoot, 'scripts/installed-profile.mjs')).href) as Profile;
  const errors: Record<string, string> = {};
  const attempt = (label: string, fn: () => unknown) => { try { fn(); errors[label] = 'ACCEPTED'; } catch (e) { errors[label] = (e as Error).message.slice(0, 90); } };
  for (const [label, uri] of [['remote host', 'mongodb://db.example.com:27017'], ['credentials', 'mongodb://u:p@localhost:27017'], ['other port', 'mongodb://localhost:27018'], ['srv', 'mongodb+srv://localhost'],
    ['database in URI', 'mongodb://localhost:27017/caudelyx_manual'], ['extra option', 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true'], ['duplicate replicaSet', 'mongodb://localhost:27017/?replicaSet=rs0&replicaSet=x']] as const)
    attempt(label, () => p.validateInstalledUri(uri));
  for (const [label, e] of [['MONGODB_DATABASE=caudelyx_manual', { MONGODB_DATABASE: 'caudelyx_manual' }], ['MONGODB_DATABASE=caudelyx_dev in test mode', { MONGODB_DATABASE: 'caudelyx_dev' }],
    ['test id not 24hex', { CAUDELYX_DEV_TEST_ID: '../../x' }], ['port 27017', { CAUDELYX_DEV_UI_PORT: '27017' }], ['port 27181', { CAUDELYX_DEV_API_PORT: '27181' }], ['ports collide', { CAUDELYX_DEV_PLATFORM_PORT: '5331' }],
    ['mode production', { CAUDELYX_MODE: 'production' }]] as const) attempt(label, () => p.installedSettings({ ...env(), ...e }));
  const settings = p.installedSettings(env());
  errors['test-mode database'] = settings.database; errors['test-mode control is own'] = String(settings.control.endsWith(join('installed-tests', RUN)));
  const devSettings = p.installedSettings({ CAUDELYX_MODE: 'local-synthetic' });
  errors['default (no test id) database'] = devSettings.database;
  let wrongSet = 'ACCEPTED'; try { await p.inspectInstalled({ mongoUri: 'mongodb://localhost:27017/?replicaSet=not-rs0' }); } catch (e) { wrongSet = (e as Error).message.slice(0, 90); }
  errors['inspect wrong replicaSet'] = wrongSet;
  evidence('P05-ENV-01', { errors });
  for (const [k, v] of Object.entries(errors)) if (!k.startsWith('test-mode') && !k.startsWith('default')) assert.notEqual(v, 'ACCEPTED', k);
  assert.equal(errors['test-mode database'], `caudelyx_s02_test_${RUN}`); assert.equal(errors['test-mode control is own'], 'true'); assert.equal(errors['default (no test id) database'], 'caudelyx_dev');
});

test('P05-ENV-02 real npm-dev launcher in the reserved profile: HTTPS verified, own DB, single instance, CLI mailbox restricted and non-consuming, LINK -> E_INITIAL (no business), stop/restart preserves data/controls/session; missing keyring or journal fail closed', { timeout: 900000 }, async () => {
  const profile = await localTestProfile();
  let run: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const observed = new Map<string, unknown>(), control = profile.directory;
    run = await launch(); observed.set('first start', run.outcome);
    assert.equal(run.outcome, 'ready', 'launcher readiness');
    const cert = await readFile(join(control, 'tls/cert.pem'));
    const descriptor = JSON.parse(await readFile(join(control, 'descriptor.json'), 'utf8')) as { databaseName: string; mongoUri: string; tenantOrigin: string; profile: string };
    observed.set('descriptor', { databaseName: descriptor.databaseName === `caudelyx_s02_test_${RUN}`, rs0: new URL(descriptor.mongoUri).searchParams.get('replicaSet'), origin: descriptor.tenantOrigin, profile: descriptor.profile });
    observed.set('UI https verified (CA = profile cert, no bypass)', await get('https://localhost:5331/', cert));
    const second = await launch(); observed.set('second concurrent launcher', { outcome: second.outcome, exit: second.child.exitCode, message: /ocupado|reservado/i.test(second.output()) });
    observed.set('first still serving after second refused', await get('https://localhost:5331/', cert));
    const p = new OriginClient(5431, cert); await p.refreshCsrf();
    observed.set('A07 anonymous through UI proxy', (await p.call('GET', '/api/v1/auth/me')).status);
    const email = `p05env_${Date.now()}@example.test`, password = 'synthetic P05 environment passphrase 37';
    const reg = await p.call('POST', '/api/v1/auth/register', { mode: 'PROFILE', email, displayName: 'Persona entorno', password, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
    observed.set('A02 PROFILE', reg.status);
    let box = await mailbox(email); for (let i = 0; i < 20 && !box.messages.length; i++) { await new Promise(r => setTimeout(r, 500)); box = await mailbox(email); }
    const again = await mailbox(email), message = box.messages.find(m => m.purpose === 'ACTIVATION');
    observed.set('mailbox', { exit: box.code, activation: Boolean(message), linkIsOwnHttpsFragment: message?.activationUrl?.startsWith('https://localhost:5331/#/activar?') ?? false,
      secondReadSameCode: again.messages.find(m => m.purpose === 'ACTIVATION')?.code === message?.code, requiresPasswordSetup: message?.requiresPasswordSetup });
    observed.set('mailbox negatives', { nonExampleDomain: (await mailbox('persona@gmail.com')).denied, productionMode: (await mailbox(email, { CAUDELYX_MODE: 'production' })).denied, malformed: (await mailbox('a@b@example.test')).denied });
    // S1 app.ts maps every unmounted route to 503 SERVICE_UNAVAILABLE (inherited); what matters is: never 2xx, never a code/link.
    const routes: Record<string, string> = {}; for (const path of ['/api/v1/mailbox', '/api/v1/auth/mailbox', '/api/v1/dev/mailbox']) { const res = await p.call('GET', path); routes[path] = `${res.status} ${res.body.data === undefined ? 'no-data' : 'DATA'}`; }
    observed.set('no HTTP mailbox routes', routes);
    const link = await p.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token: message?.code });
    await p.refreshCsrf();
    const me = await p.call('GET', '/api/v1/auth/me');
    observed.set('LINK -> E_INITIAL', { link: link.status, authState: me.body.data?.['authState'], nextAction: me.body.data?.['nextAction'] });
    observed.set('E_INITIAL on business', { organization: (await p.call('GET', '/api/v1/organization')).status, finance: (await p.call('GET', `/api/v1/organizations/${randomUUID()}/financial/accounts`)).status });
    observed.set('mailbox after LINK (consumed code no longer listed)', (await mailbox(email)).messages.some(m => m.code === message?.code));
    const files = ['keys.json', 'tls/key.pem', 'tls/cert.pem'];
    const before: Record<string, string> = {}; for (const f of files) before[f] = await sha(join(control, f));
    const journal = join(control, `gate-${descriptor.databaseName}.json.journal.jsonl`), journalBefore = (await stat(journal)).size;
    observed.set('stop exit code', await shutdown(run.child));
    observed.set('ports free after stop', await get('https://localhost:5331/', cert));
    run = await launch(); observed.set('restart', run.outcome); assert.equal(run.outcome, 'ready');
    const after: Record<string, string> = {}; for (const f of files) after[f] = await sha(join(control, f));
    const meAgain = await p.call('GET', '/api/v1/auth/me');
    observed.set('after restart', { controlsIdentical: JSON.stringify(before) === JSON.stringify(after), sameCookieStillValid: meAgain.status, authState: meAgain.body.data?.['authState'], journalNotReset: (await stat(journal)).size >= journalBefore });
    // Missing keyring on an existing profile: refuse, never regenerate.
    await shutdown(run.child); await rename(join(control, 'keys.json'), join(control, 'keys.json.p05held'));
    try { run = await launch(); observed.set('missing keyring', { outcome: run.outcome, refused: /keyring/i.test(run.output()), ui: await get('https://localhost:5331/', cert) }); }
    finally { if (run.child.exitCode === null) await shutdown(run.child); await rename(join(control, 'keys.json.p05held'), join(control, 'keys.json')); }
    // Missing signed journal: closed (no readiness, no fabricated evidence); restoring the file alone does not reopen.
    await rename(journal, journal + '.p05held');
    try { run = await launch(); observed.set('missing journal', { outcome: run.outcome, closedMessage: /realm cerrado|no disponible/i.test(run.output()), ui: await get('https://localhost:5331/', cert) }); }
    finally { if (run.child.exitCode === null) await shutdown(run.child); await rename(journal + '.p05held', journal); }
    run = await launch(); observed.set('journal restored, no review', { outcome: run.outcome });
    if (run.child.exitCode === null) await shutdown(run.child);
    evidence('P05-ENV-02', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('descriptor'), { databaseName: true, rs0: 'rs0', origin: 'https://localhost:5331', profile: 'installed-s02' });
    assert.equal(observed.get('UI https verified (CA = profile cert, no bypass)'), 200);
    assert.deepEqual(observed.get('second concurrent launcher'), { outcome: 'exited', exit: 1, message: true }); assert.equal(observed.get('first still serving after second refused'), 200);
    assert.equal(observed.get('A07 anonymous through UI proxy'), 401); assert.equal(observed.get('A02 PROFILE'), 202);
    assert.deepEqual(observed.get('mailbox'), { exit: 0, activation: true, linkIsOwnHttpsFragment: true, secondReadSameCode: true, requiresPasswordSetup: false });
    assert.deepEqual(observed.get('mailbox negatives'), { nonExampleDomain: true, productionMode: true, malformed: true });
    for (const v of Object.values(routes)) assert.match(v, /^(404|503) no-data$/);
    assert.deepEqual(observed.get('LINK -> E_INITIAL'), { link: 200, authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR' });
    const biz = observed.get('E_INITIAL on business') as Record<string, number>; assert.ok(biz['organization']! >= 400 && biz['finance']! >= 400);
    assert.equal(observed.get('mailbox after LINK (consumed code no longer listed)'), false);
    assert.equal(observed.get('stop exit code'), 0); assert.equal(observed.get('ports free after stop'), -1);
    assert.deepEqual(observed.get('after restart'), { controlsIdentical: true, sameCookieStillValid: 200, authState: 'MFA_ENROLLMENT', journalNotReset: true });
    assert.deepEqual(observed.get('missing keyring'), { outcome: 'exited', refused: true, ui: -1 });
    const mj = observed.get('missing journal') as Record<string, unknown>; assert.equal(mj['outcome'], 'exited'); assert.equal(mj['ui'], -1);
    assert.deepEqual(observed.get('journal restored, no review'), { outcome: 'exited' });
  } finally {
    if (run && run.child.exitCode === null) await shutdown(run.child);
    await profile.dispose();
  }
});
