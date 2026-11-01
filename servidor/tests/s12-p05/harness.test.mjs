/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- S12-P05 own isolated sandbox and closed own case maps under the session scratchpad; real candidate only read. */
// S12-P05 (Claude): H-S11-P05-01 / H-S10-P05-01 re-validation. The sealed P04 harness (runner, compiled fixture/self-tests,
// verifier self-test, package script) is executed ONLY inside an isolated copy with a copied seal, never in the real tree.
// Expectation (S11_FIXES_DELTA_S12 H01): refusal before ANY mkdir/log/append/receipt/lock, on early and late failure paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';

const REAL = path.resolve('../..'), SERVER = path.resolve('.'), EV = path.join(REAL, 'Construccion/Sprints/S12/Evidencias');
const BASE = process.env.P05_SANDBOX_BASE; if (!BASE || BASE.startsWith(REAL)) throw Error('Sandbox must be outside the project');
const box = path.join(BASE, 'h' + randomUUID().slice(0, 8)), bServer = path.join(box, 'Caudelyx/servidor'), bEv = path.join(box, 'Construccion/Sprints/S12/Evidencias');
const checks = {};
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function inventory(root) { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.name === 'node_modules') continue; if (e.isDirectory()) { out[path.relative(root, p) + '/'] = 'dir'; walk(p); } else { const s = fs.statSync(p); out[path.relative(root, p)] = [sha(p), s.size, s.mtimeMs]; } } }; walk(root); return out; }
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
const run = (args, cwd, env = {}) => { const t = performance.now(), r = spawnSync(args[0], args.slice(1), {cwd, encoding: 'utf8', env: Object.fromEntries(Object.entries({...process.env, ...env}).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), timeout: 120000, windowsHide: true}); return {exit: r.status, ms: Math.round(performance.now() - t), tail: (r.stderr + r.stdout).split('\n').filter(l => /Error|FROZEN|assert|refus|ENOENT|not ok|fail|^ℹ (tests|pass|fail)|^# (tests|pass|fail)/i.test(l)).slice(0, 8).map(l => l.slice(0, 200)), raw: (r.stderr + r.stdout).slice(0, 1500)}; };

test('S12-P05 H01: sealed P04 harness refuses before any write in an isolated copy (success/early/late paths)', async t => {
  fs.mkdirSync(path.join(bServer, 'scripts'), {recursive: true}); fs.mkdirSync(bEv, {recursive: true}); fs.mkdirSync(path.join(bServer, 'tests/s12-p04'), {recursive: true});
  try {
    for (const n of ['s12-p04-guard.mjs', 's12-p04-runner.mjs', 's12-p04-verify.mjs']) fs.copyFileSync(path.join(SERVER, 'scripts', n), path.join(bServer, 'scripts', n));
    fs.copyFileSync(path.join(SERVER, 'tests/s12-p04/verifier.test.mjs'), path.join(bServer, 'tests/s12-p04/verifier.test.mjs'));
    fs.cpSync(path.join(SERVER, 'dist-s12-p04'), path.join(bServer, 'dist-s12-p04'), {recursive: true});
    for (const n of ['S12-P04-HASHES.json', 'S12-P04-RUNS.json', 'S12-P04-RESOURCES.jsonl', 'S12-P04-VERIFY.json', 'S12-P04-TIMINGS.json', 'S12-P04-package.py', 'S12-P04-INPUTS.json', 'S12-P01-HASHES.json']) fs.copyFileSync(path.join(EV, n), path.join(bEv, n));
    fs.symlinkSync(path.join(SERVER, 'node_modules'), path.join(bServer, 'node_modules'), 'junction');
    for (const n of ['package.json', 'tsconfig.json', 'tsconfig.s12-p04.json']) fs.copyFileSync(path.join(SERVER, n), path.join(bServer, n));
    fs.copyFileSync(process.env.P05_PROBE, path.join(bEv, 'probe.py'));
    // Read-only inputs the sealed self-tests load at start-up, so their LATE path (fixture receipt) is reached.
    for (const rel of ['Construccion/Sprints/S11/Plantillas', 'Caudelyx/servidor/src/modules/exchange/assets', ...fs.readdirSync(path.join(REAL, 'Construccion/Sprints')).filter(s => fs.existsSync(path.join(REAL, 'Construccion/Sprints', s, 'Contratos'))).map(s => 'Construccion/Sprints/' + s + '/Contratos')]) fs.cpSync(path.join(REAL, rel), path.join(box, rel), {recursive: true});
    for (const rel of [...Object.keys(JSON.parse(fs.readFileSync(path.join(EV, 'S12-P01-HASHES.json'), 'utf8')).files), 'Construccion/Sprints/S11/Evidencias/S11-P04-RUNS.json', 'Construccion/Sprints/S11/Evidencias/S11-P04-VERIFY.json', 'Caudelyx/servidor/dist-s11-p04/src/app.js']) { fs.mkdirSync(path.dirname(path.join(box, rel)), {recursive: true}); if (!fs.existsSync(path.join(box, rel))) fs.copyFileSync(path.join(REAL, rel), path.join(box, rel)); }
    const sealedCopy = {hashes: sha(path.join(bEv, 'S12-P04-HASHES.json')), resources: sha(path.join(bEv, 'S12-P04-RESOURCES.jsonl')), real: sha(path.join(EV, 'S12-P04-RESOURCES.jsonl'))};
    assert.equal(sealedCopy.hashes, '6727eea0764288631385730b7baa5a06cc3675a69cdcc2c837aa882f000d82f8'); assert.equal(sealedCopy.resources, sealedCopy.real);
    const before = inventory(box), node = process.execPath;
    const cases = {
      'runner-stage-finance (late path: would compile+Mongo)': [[node, 'scripts/s12-p04-runner.mjs', 'finance'], bServer],
      'runner-invalid-stage (early)': [[node, 'scripts/s12-p04-runner.mjs', 'bogus'], bServer],
      'runner-guard-stage (success path)': [[node, 'scripts/s12-p04-runner.mjs', 'guard'], bServer],
      'compiled-fixture-selftest finance.test.js': [[node, '--test', 'dist-s12-p04/tests/s12-p04/finance.test.js'], bServer],
      'compiled-selftest lifecycle.test.js': [[node, '--test', 'dist-s12-p04/tests/s12-p04/lifecycle.test.js'], bServer],
      'compiled-selftest fixes.test.js': [[node, '--test', 'dist-s12-p04/tests/s12-p04/fixes.test.js'], bServer],
      'verifier selftest tests/s12-p04/verifier.test.mjs': [[node, '--test', 'tests/s12-p04/verifier.test.mjs'], bServer],
      'python path probe': [['python', '-I', path.join(bEv, 'probe.py')], bEv],
      'package.py prepare': [['python', '-I', path.join(bEv, 'S12-P04-package.py'), 'prepare'], bEv],
      'package.py seal': [['python', '-I', path.join(bEv, 'S12-P04-package.py'), 'seal'], bEv],
      'author verifier (read-only success)': [[node, 'scripts/s12-p04-verify.mjs'], bServer]};
    const results = {};
    for (const [label, [args, cwd]] of Object.entries(cases)) { const r = run(args, cwd), after = inventory(box), delta = changed(before, after); results[label] = {...r, sandboxChanges: delta}; await t.test(label, () => assert.deepEqual(delta, [], label + ' wrote ' + JSON.stringify(delta))); }
    checks['sealedCopy'] = sealedCopy; checks['cases'] = results;
    // Own guard-semantics probes on an UNSEALED copy (no HASHES): aliasing, traversal, case, ADS, 8.3 and runtime-name forms are refused.
    const open = path.join(BASE, 'o' + randomUUID().slice(0, 8)); fs.mkdirSync(path.join(open, 'Construccion/Sprints/S12/Evidencias'), {recursive: true}); fs.mkdirSync(path.join(open, 'Caudelyx/servidor/.runtime'), {recursive: true}); fs.mkdirSync(path.join(open, 'Construccion/Sprints/S11/Evidencias'), {recursive: true});
    try {
      const guard = await import('file://' + path.join(bServer, 'scripts/s12-p04-guard.mjs').replaceAll('\\', '/'));
      fs.symlinkSync(path.join(open, 'Construccion/Sprints/S11/Evidencias'), path.join(open, 'Caudelyx/servidor/.runtime/s12-p04-' + 'a'.repeat(24)), 'junction');
      const probes = {allowed: 'Construccion/Sprints/S12/Evidencias/S12-P04-own.json', traversal: 'Construccion/Sprints/S12/Evidencias/../../S11/Evidencias/S11-P04-RUNS.json', lowerCase: 'construccion/sprints/s12/evidencias/S12-P04-x.json', ads: 'Construccion/Sprints/S12/Evidencias/S12-P04-x.json:hidden', shortName: 'CONSTR~1/Sprints/S12/Evidencias/S12-P04-x.json', junctionRuntime: 'Caudelyx/servidor/.runtime/s12-p04-' + 'a'.repeat(24) + '/sealed.log', otherTask: 'Construccion/Sprints/S12/Evidencias/S12-P02-HASHES.json', outside: '../outside.txt'};
      const g = {}; for (const [k, rel] of Object.entries(probes)) { try { await guard.assertWritable(path.join(open, rel), open); g[k] = 'ALLOWED'; } catch (e) { g[k] = String(e.message); } }
      checks['guardProbes'] = g;
      assert.equal(g.allowed, 'ALLOWED'); for (const k of Object.keys(probes).filter(k => k !== 'allowed')) assert.notEqual(g[k], 'ALLOWED', k);
    } finally { fs.rmSync(open, {recursive: true, force: true}); }
    checks['realSealAfter'] = sha(path.join(EV, 'S12-P04-RESOURCES.jsonl')) === sealedCopy.real && sha(path.join(EV, 'S12-P04-HASHES.json')) === sealedCopy.hashes;
    assert.ok(checks['realSealAfter']);
  } finally {
    try { fs.unlinkSync(path.join(bServer, 'node_modules')); } catch { /* junction may not exist on early failure */ }
    // Never recurse while the junction to the real node_modules could still exist.
    if (!fs.existsSync(path.join(bServer, 'node_modules'))) fs.rmSync(box, {recursive: true, force: true}); checks['sandboxRemoved'] = !fs.existsSync(box);
    fs.writeFileSync(path.join(EV, 'S12-P05-CHECKS-HARNESS.json'), JSON.stringify({task: 'S12-P05', suite: 'harness', at: new Date().toISOString(), sandbox: 'scratchpad (outside project)', checks}, null, 1) + '\n');
    void execFileSync;
  }
});
