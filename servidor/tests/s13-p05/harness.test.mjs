/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- S13-P05 own isolated sandbox under the session scratchpad and closed own case maps; real candidate only read. */
// S13-P05 (Claude): independent review of the S13-P04 guards (runner/compiled self-tests/guard self-test/packager/verifier).
// The sealed harness runs ONLY inside isolated copies with a copied seal: a short box and a box whose seal path exceeds 260
// characters (Windows MAX_PATH, the S12-P05 O-2 scenario). Expectation: refusal before ANY write/lock/receipt; copies unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';

const REAL = path.resolve('../..'), SERVER = path.resolve('.'), EV = path.join(REAL, 'Construccion/Sprints/S13/Evidencias');
const BASE = process.env.P05_SANDBOX_BASE; if (!BASE || BASE.startsWith(REAL)) throw Error('Sandbox must be outside the project');
const checks = {};
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function inventory(root) { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.name === 'node_modules') continue; if (e.isDirectory()) { out[path.relative(root, p) + '/'] = 'dir'; walk(p); } else { const s = fs.statSync(p); out[path.relative(root, p)] = [sha(p), s.size, s.mtimeMs]; } } }; walk(root); return out; }
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
const run = (args, cwd, env = {}) => { const t = performance.now(), r = spawnSync(args[0], args.slice(1), {cwd, encoding: 'utf8', env: Object.fromEntries(Object.entries({...process.env, ...env}).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), timeout: 180000, windowsHide: true}); const all = (r.stderr ?? '') + (r.stdout ?? ''); return {exit: r.status, ms: Math.round(performance.now() - t), reason: (all.match(/(FROZEN_[A-Z0-9_]+|[A-Z_]*NO_WRITES|AMBIGUOUS_OUTPUT_PATH|CANCELLED_BEFORE_OUTPUT|ENOENT[^\n]{0,60}|INVALID_[A-Z_]+|MISSING_ANCESTOR[A-Z_]*|ALIAS[A-Z_]*)/) ?? [null])[0], tapPass: (all.match(/ℹ pass (\d+)/) ?? [null, null])[1]}; };

async function sealedBox(t, label, boxName) {
  const box = path.join(BASE, boxName), bServer = path.join(box, 'Caudelyx/servidor'), bEv = path.join(box, 'Construccion/Sprints/S13/Evidencias'), out = {box: box.length, sealPathLength: path.join(bEv, 'S13-P04-HASHES.json').length};
  fs.mkdirSync(path.join(bServer, 'scripts'), {recursive: true}); fs.mkdirSync(bEv, {recursive: true}); fs.mkdirSync(path.join(bServer, 'tests/s13-p04'), {recursive: true});
  try {
    for (const n of ['s13-p04-guard.mjs', 's13-p04-runner.mjs', 's13-p04-verify.mjs']) fs.copyFileSync(path.join(SERVER, 'scripts', n), path.join(bServer, 'scripts', n));
    fs.copyFileSync(path.join(SERVER, 'tests/s13-p04/guard.test.mjs'), path.join(bServer, 'tests/s13-p04/guard.test.mjs'));
    fs.cpSync(path.join(SERVER, 'dist-s13-p04'), path.join(bServer, 'dist-s13-p04'), {recursive: true});
    for (const n of fs.readdirSync(EV).filter(n => /^S13-P0[1-4]-/.test(n) && fs.statSync(path.join(EV, n)).isFile())) fs.copyFileSync(path.join(EV, n), path.join(bEv, n));
    fs.symlinkSync(path.join(SERVER, 'node_modules'), path.join(bServer, 'node_modules'), 'junction');
    for (const n of ['package.json', 'tsconfig.json', 'tsconfig.s13-p04.json']) fs.copyFileSync(path.join(SERVER, n), path.join(bServer, n));
    for (const rel of ['Construccion/Sprints/S11/Plantillas', 'Caudelyx/servidor/src/modules/exchange/assets', ...fs.readdirSync(path.join(REAL, 'Construccion/Sprints')).filter(s => fs.existsSync(path.join(REAL, 'Construccion/Sprints', s, 'Contratos'))).map(s => 'Construccion/Sprints/' + s + '/Contratos')]) fs.cpSync(path.join(REAL, rel), path.join(box, rel), {recursive: true});
    out.sealCopy = sha(path.join(bEv, 'S13-P04-HASHES.json')) === '4e2393181eccd34fc068052211ee1c4bd119ff38f98e4beb3f0f84c0324d0733';
    assert.ok(out.sealCopy);
    const before = inventory(box), node = process.execPath;
    const cases = {
      'runner finance (late path: compile+Mongo)': [[node, 'scripts/s13-p04-runner.mjs', 'finance'], bServer],
      'runner recovery': [[node, 'scripts/s13-p04-runner.mjs', 'recovery'], bServer],
      'runner invalid stage (early)': [[node, 'scripts/s13-p04-runner.mjs', 'bogus'], bServer],
      'runner guard stage (success path)': [[node, 'scripts/s13-p04-runner.mjs', 'guard'], bServer],
      'runner with cancellation env': [[node, 'scripts/s13-p04-runner.mjs', 'pure'], bServer, {CAUDELYX_S13_CANCEL: '1'}],
      'compiled self-test finance.test.js': [[node, '--test', 'dist-s13-p04/tests/s13-p04/finance.test.js'], bServer],
      'compiled self-test recovery.test.js': [[node, '--test', 'dist-s13-p04/tests/s13-p04/recovery.test.js'], bServer],
      'compiled self-test writes.test.js': [[node, '--test', 'dist-s13-p04/tests/s13-p04/writes.test.js'], bServer],
      'guard self-test tests/s13-p04/guard.test.mjs': [[node, '--test', 'tests/s13-p04/guard.test.mjs'], bServer],
      'package.py collect': [['python', '-I', path.join(bEv, 'S13-P04-package.py'), 'collect'], bEv],
      'package.py seal': [['python', '-I', path.join(bEv, 'S13-P04-package.py'), 'seal'], bEv],
      'package.py guard-test': [['python', '-I', path.join(bEv, 'S13-P04-package.py'), 'guard-test'], bEv],
      'author verifier (read-only)': [[node, 'scripts/s13-p04-verify.mjs', '--sha256=4e2393181eccd34fc068052211ee1c4bd119ff38f98e4beb3f0f84c0324d0733'], bServer]};
    out.cases = {};
    for (const [name, [args, cwd, env]] of Object.entries(cases)) { const r = run(args, cwd, env), delta = changed(before, inventory(box)); out.cases[name] = {...r, sandboxChanges: delta}; await t.test(label + ': ' + name, () => assert.deepEqual(delta, [], name + ' wrote ' + JSON.stringify(delta))); }
  } finally {
    try { fs.unlinkSync(path.join(bServer, 'node_modules')); } catch { /* junction may not exist on early failure */ }
    if (!fs.existsSync(path.join(bServer, 'node_modules'))) fs.rmSync(box, {recursive: true, force: true}); out.removed = !fs.existsSync(box);
  }
  return out;
}

test('S13-P05 guards: sealed P04 harness refuses before any write (short and >260-char boxes), own guard probes', {timeout: 900000}, async t => {
  const realBefore = {hashes: sha(path.join(EV, 'S13-P04-HASHES.json')), resources: sha(path.join(EV, 'S13-P04-RESOURCES.jsonl')), runs: sha(path.join(EV, 'S13-P04-RUNS.json'))};
  try {
    checks.short = await sealedBox(t, 'short', 'h' + randomUUID().slice(0, 8));
    const longName = 'L' + 'x'.repeat(Math.max(10, 275 - path.join(BASE, 'Construccion/Sprints/S13/Evidencias/S13-P04-HASHES.json').length));
    checks.long = await sealedBox(t, 'long', longName);
    // Own probes of the P04 guard semantics on an UNSEALED copy (lexical/alias/ADS/8.3/length/junction/parent-not-dir/cancel).
    const open = path.join(BASE, 'o' + randomUUID().slice(0, 8));
    fs.mkdirSync(path.join(open, 'Caudelyx/servidor/scripts'), {recursive: true}); fs.mkdirSync(path.join(open, 'Construccion/Sprints/S13/Evidencias'), {recursive: true}); fs.mkdirSync(path.join(open, 'Caudelyx/servidor/.runtime'), {recursive: true}); fs.mkdirSync(path.join(open, 'Construccion/Sprints/S11/Evidencias'), {recursive: true});
    fs.copyFileSync(path.join(SERVER, 'scripts/s13-p04-guard.mjs'), path.join(open, 'Caudelyx/servidor/scripts/s13-p04-guard.mjs'));
    try {
      const guard = await import('file://' + path.join(open, 'Caudelyx/servidor/scripts/s13-p04-guard.mjs').replaceAll('\\', '/'));
      fs.symlinkSync(path.join(open, 'Construccion/Sprints/S11/Evidencias'), path.join(open, 'Caudelyx/servidor/.runtime/s13-p04-' + 'a'.repeat(24)), 'junction');
      const E = 'Construccion/Sprints/S13/Evidencias/';
      const probes = {allowed: E + 'S13-P04-own.json', traversal: E + '../../S11/Evidencias/S11-P04-RUNS.json', lowerCase: 'construccion/sprints/s13/evidencias/S13-P04-x.json', ads: E + 'S13-P04-x.json:hidden', shortName: 'CONSTR~1/Sprints/S13/Evidencias/S13-P04-x.json', trailingDot: E + 'S13-P04-x.json.', trailingSpace: E + 'S13-P04-x.json ', longPath: E + 'S13-P04-' + 'y'.repeat(250) + '.json', junctionRuntime: 'Caudelyx/servidor/.runtime/s13-p04-' + 'a'.repeat(24) + '/sealed.log', otherTask: E + 'S13-P05-x.json', outside: '../outside.txt'};
      const g = {}; for (const [k, rel] of Object.entries(probes)) { try { await guard.assertWritable(path.join(open, rel), open); g[k] = 'ALLOWED'; } catch (e) { g[k] = String(e.message); } }
      try { await guard.assertWritable('\\\\?\\' + path.join(open, E + 'S13-P04-x.json'), open); g.extendedPrefix = 'ALLOWED'; } catch (e) { g.extendedPrefix = String(e.message); }
      process.env.CAUDELYX_S13_CANCEL = '1'; try { await guard.assertWritable(path.join(open, E + 'S13-P04-c.json'), open); g.cancelEnv = 'ALLOWED'; } catch (e) { g.cancelEnv = String(e.message); } finally { delete process.env.CAUDELYX_S13_CANCEL; }
      // Evidence parent replaced by a FILE: seal state cannot be determined -> must refuse (fail closed).
      const notDir = path.join(BASE, 'n' + randomUUID().slice(0, 8)); fs.mkdirSync(path.join(notDir, 'Construccion/Sprints/S13'), {recursive: true}); fs.writeFileSync(path.join(notDir, 'Construccion/Sprints/S13/Evidencias'), 'not a directory');
      try { await guard.assertWritable(path.join(notDir, 'Caudelyx/servidor/.runtime/s13-p04-' + 'b'.repeat(24) + '/x'), notDir); g.sealParentNotDirectory = 'ALLOWED'; } catch (e) { g.sealParentNotDirectory = String(e.message); } finally { fs.rmSync(notDir, {recursive: true, force: true}); }
      checks.guardProbes = g;
      assert.equal(g.allowed, 'ALLOWED'); for (const k of Object.keys(g).filter(k => k !== 'allowed')) assert.notEqual(g[k], 'ALLOWED', k);
    } finally { fs.rmSync(open, {recursive: true, force: true}); }
    checks.realSealUnchanged = sha(path.join(EV, 'S13-P04-HASHES.json')) === realBefore.hashes && sha(path.join(EV, 'S13-P04-RESOURCES.jsonl')) === realBefore.resources && sha(path.join(EV, 'S13-P04-RUNS.json')) === realBefore.runs;
    assert.ok(checks.realSealUnchanged);
  } finally {
    fs.writeFileSync(path.join(EV, 'S13-P05-CHECKS-HARNESS.json'), JSON.stringify({task: 'S13-P05', suite: 'harness', at: new Date().toISOString(), sandbox: 'scratchpad (outside project)', checks}, null, 1) + '\n');
  }
});
