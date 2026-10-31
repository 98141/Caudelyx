/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own maps keyed by own file names; Own registered filesystem group .runtime/s11-p05-verifier-<uuid> and fixed S11 evidence paths read-only. */
// S11-P05 (Claude): H-S10-P05-01 / AT12. Own synthetic candidate; the NEW CLI s11-p04-verify.mjs is run as a child process exactly
// as an operator would. Read-only is proven by sha/size/mtimeNs inventories (candidate + real S11 P04 evidence) before/after.
// The synthetic build-state shape (FORMAT/buildFingerprint) is mechanical; every expectation below is own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {randomUUID, createHash} from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {FORMAT, buildFingerprint} from '../../scripts/s11-verifier-core.mjs';

const sha = b => createHash('sha256').update(b).digest('hex'), repo = path.resolve('../..'), evidence = path.join(repo, 'Construccion/Sprints/S11/Evidencias');
async function stamp(file) { const s = await fs.lstat(file, {bigint: true}); return [String(s.size), String(s.mtimeNs), s.isFile() ? sha(await fs.readFile(file)) : 'dir']; }
async function tree(dir) { const out = {}; for (const e of await fs.readdir(dir, {withFileTypes: true})) { assert.equal(e.isSymbolicLink(), false); const p = path.join(dir, e.name); out[e.name] = e.isDirectory() ? await tree(p) : await stamp(p); } return out; }
async function sealedP04() { const out = {}; for (const n of (await fs.readdir(evidence)).filter(n => n.startsWith('S11-P04-') && !n.endsWith('SIDECARS'))) { const p = path.join(evidence, n); if ((await fs.lstat(p)).isFile()) out[n] = await stamp(p); } return out; }
const cli = args => { const r = spawnSync(process.execPath, ['scripts/s11-p04-verify.mjs', ...args], {encoding: 'utf8'}); return {exit: r.status, out: JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}')}; };

test('S11-P05 verifier: read-only PASS, rejections without writes, no --fixture, exclusive sidecar outside the seal', async () => {
  const id = randomUUID(), own = path.resolve('.runtime', 's11-p05-verifier-' + id), cand = path.join(own, 'candidate'), receipts = path.join(own, 'receipts'), checks = {};
  await fs.mkdir(own, {recursive: false}); await fs.writeFile(path.join(own, 'owner.json'), JSON.stringify({id, pid: process.pid}), {flag: 'wx'});
  await fs.mkdir(path.join(cand, 'src'), {recursive: true}); await fs.mkdir(path.join(cand, 'dist')); await fs.mkdir(receipts);
  const sealedBefore = await sealedP04();
  try {
    const build = async (mutate = '') => {
      for (const extra of ['src/extra.ts', 'dist/extra.js']) await fs.rm(path.join(cand, extra), {force: true});
      await fs.writeFile(path.join(cand, 'src/unit.ts'), 'export const p05 = 1;\n'); await fs.writeFile(path.join(cand, 'dist/unit.js'), 'export const p05 = 1;\n');
      const inputs = [['src/unit.ts', sha(await fs.readFile(path.join(cand, 'src/unit.ts')))]], outputs = [['dist/unit.js', sha(await fs.readFile(path.join(cand, 'dist/unit.js')))]], metadata = {compiler: 'p05-synthetic', version: 1};
      const state = {format: FORMAT, metadata, inputs: Object.fromEntries(inputs), outputs: Object.fromEntries(outputs), inputFingerprint: buildFingerprint(metadata, inputs), inputSets: [{directory: 'src', extensions: ['.ts'], excludeDirectories: []}], explicitInputs: [], outputDirectory: 'dist'};
      await fs.writeFile(path.join(cand, 'build.json'), JSON.stringify(state));
      let manifest = JSON.stringify({files: Object.fromEntries([...inputs, ...outputs, ['build.json', sha(await fs.readFile(path.join(cand, 'build.json')))]])});
      if (mutate === 'escape') manifest = JSON.stringify({files: {'../outside.txt': '0'.repeat(64)}});
      if (mutate === 'duplicate-key') manifest = manifest.replace('{"src/unit.ts"', '{"src/unit.ts":"' + inputs[0][1] + '","src/unit.ts"');
      await fs.writeFile(path.join(cand, 'seal.json'), manifest);
      if (mutate === 'tamper') await fs.writeFile(path.join(cand, 'dist/unit.js'), 'export const p05 = 2;\n');
      if (mutate === 'missing-compiled') await fs.unlink(path.join(cand, 'dist/unit.js'));
      if (mutate === 'stale-compiled') { await fs.writeFile(path.join(cand, 'src/unit.ts'), 'export const p05 = 3;\n'); const m = JSON.parse(manifest); m.files['src/unit.ts'] = sha(await fs.readFile(path.join(cand, 'src/unit.ts'))); await fs.writeFile(path.join(cand, 'seal.json'), JSON.stringify(m)); }
      if (mutate === 'extra-output') await fs.writeFile(path.join(cand, 'dist/extra.js'), 'export const x = 1;\n');
      if (mutate === 'extra-input') await fs.writeFile(path.join(cand, 'src/extra.ts'), 'export const x = 1;\n');
      return sha(await fs.readFile(path.join(cand, 'seal.json')));
    };
    const base = shaSeal => ['--root', cand, '--manifest', 'seal.json', '--sha256', shaSeal, '--build-state', 'build.json'];
    const run = async (name, mutate, extra = [], shaOverride) => {
      const s = await build(mutate), before = await tree(own), r = cli([...base(shaOverride ?? s), ...extra]), after = await tree(own);
      checks[name] = {exit: r.exit, result: r.out.result, error: r.out.error ?? null, readOnly: r.out.readOnly, ownTreeUnchanged: JSON.stringify(before) === JSON.stringify(after)};
      return {r, before, after};
    };
    const ok = await run('pass', ''); assert.equal(ok.r.out.result, 'PASS'); assert.equal(ok.r.out.readOnly, true); assert.deepEqual(ok.after, ok.before);
    for (const [name, mutate, extra, over] of [['tamper', 'tamper'], ['missing-compiled', 'missing-compiled'], ['wrong-trusted-sha', '', [], 'f'.repeat(64)], ['escape-path', 'escape'], ['duplicate-json-key', 'duplicate-key'], ['stale-compiled', 'stale-compiled'], ['extra-output', 'extra-output'], ['extra-input', 'extra-input'], ['fixture-flag', '', ['--fixture', 'x']], ['sidecar-without-root', '', ['--sidecar', path.join(receipts, 'a.json')]]]) {
      const x = await run(name, mutate, extra, over); assert.equal(x.r.out.result, 'FAIL', name); assert.notEqual(x.r.exit, 0, name); assert.deepEqual(x.after, x.before, name + ' must not write');
    }
    // Exclusive sidecar: explicit absolute root+file outside the sealed set; second attempt EEXIST, file untouched; inside candidate refused.
    const s = await build(''), target = path.join(receipts, 'p05.json');
    const first = cli([...base(s), '--sidecar-root', receipts, '--sidecar', target]), stamped = await stamp(target);
    const second = cli([...base(s), '--sidecar-root', receipts, '--sidecar', target]), stampedAgain = await stamp(target);
    const inside = cli([...base(s), '--sidecar-root', cand, '--sidecar', path.join(cand, 'receipt.json')]);
    checks['sidecar'] = {first: first.out.result, firstReadOnly: first.out.readOnly, second: second.out.error, unchanged: JSON.stringify(stamped) === JSON.stringify(stampedAgain), insideSealed: inside.out.error ?? inside.out.result};
    assert.equal(first.out.result, 'PASS'); assert.equal(second.out.error, 'EEXIST'); assert.deepEqual(stampedAgain, stamped); assert.equal(inside.out.result, 'FAIL');
    await assert.rejects(fs.access(path.join(cand, 'receipt.json')));
  } finally {
    const sealedAfter = await sealedP04(); checks['realSealedP04EvidenceUnchanged'] = JSON.stringify(sealedAfter) === JSON.stringify(sealedBefore); checks['sealedFiles'] = Object.keys(sealedBefore).length;
    await fs.rm(own, {recursive: true, force: false});
    await fs.writeFile(path.join(evidence, 'S11-P05-CHECKS-VERIFIER.json'), JSON.stringify({task: 'S11-P05', suite: 'verifier', runId: id, ownRootRemoved: true, at: new Date().toISOString(), checks}, null, 1) + '\n');
    assert.deepEqual(sealedAfter, sealedBefore);
  }
});
