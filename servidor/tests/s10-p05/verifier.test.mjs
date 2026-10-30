/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own fixed observation labels and only the own registered fixture folder under .runtime/s10-p05-verifier-<id>, checked before removal. */
// S10-P05 own review of the read-only verifier core (H-S9-P05-01): builds an OWN synthetic candidate (source, compiled output, pinned
// snapshot, CAUDELYX_COMPILED_INPUTS_V1 build state, manifest) in an own filesystem group and checks: PASS with byte/size/mtime inventory
// unchanged and readOnly=true; independent namespace not contaminating; rejections for tamper, missing, wrong trusted SHA, path escape,
// duplicate JSON key, stale compiled output, extra compiled output, unlisted compiled input; sidecar never inside sealed set nor
// overwriting. The real candidate is verified separately by the default stdout mode (before/after inventory in CHECKS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { verifyCandidate, writeSidecar, digest, listFingerprint, buildFingerprint, FORMAT } from '../../scripts/s10-verifier-core.mjs';

const runtime = path.resolve('.runtime'), id = randomBytes(12).toString('hex'), folder = path.join(runtime, 's10-p05-verifier-' + id);
const receipts = path.resolve('../../Construccion/Sprints/S10/Evidencias/S10-P05-RESOURCES.jsonl');
const receipt = async r => fs.appendFile(receipts, JSON.stringify({ at: new Date().toISOString(), task: 'S10-P05', kind: 'filesystem', groupId: id, folder, ...r }) + '\n');

test('S10-P05 verificador propio: solo lectura e invariancia, rechazos y namespace independiente', { timeout: 120000 }, async () => {
  const o = {}, started = performance.now();
  await receipt({ event: 'reserved-before-create' }); try { await fs.lstat(folder); throw Error('Existing own folder'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(folder); await receipt({ event: 'created' });
  try {
    const w = (rel, data) => fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true }).then(() => fs.writeFile(path.join(folder, rel), data));
    const src = Buffer.from('export const value = 1;\n'), out = Buffer.from('export const value = 1;\n//# compiled\n');
    await w('src/a.ts', src); await w('out/a.js', out);
    const inputs = [{ path: 'src/a.ts', sha256: digest(src) }], outputs = [{ path: 'out/a.js', sha256: digest(out) }], metadata = { tool: 'SYN-TSC', flags: ['--strict'] };
    const fp = listFingerprint([['src/a.ts', digest(src)]]);
    const snapshot = Buffer.from(JSON.stringify({ sources: [{ path: 'src/a.ts', sha256: digest(src), bytes: src.length, base64: src.toString('base64') }], sourceFingerprint: fp }));
    const state = (over = {}) => Buffer.from(JSON.stringify({ format: FORMAT, metadata, inputs, outputs, inputFingerprint: buildFingerprint(metadata, inputs.map(x => [x.path, x.sha256])), inputSets: [{ directory: 'src', extensions: ['.ts'], excludeDirectories: [] }], explicitInputs: [], outputDirectory: 'out', ...over }));
    const build = state(); await w('snapshot.json', snapshot); await w('build.json', build);
    const manifestOf = files => Buffer.from(JSON.stringify({ files, sourceFingerprint: fp }));
    const files = { 'src/a.ts': digest(src), 'out/a.js': digest(out), 'snapshot.json': digest(snapshot), 'build.json': digest(build) }, manifest = manifestOf(files); await w('manifest.json', manifest);
    await w('reviewer/nota.md', 'Namespace independiente del revisor, no es entrada del producto\n');
    const opts = { root: folder, manifest: 'manifest.json', expectedManifestSHA256: digest(manifest), snapshot: 'snapshot.json', buildState: 'build.json' };
    const inventory = async () => { const rows = []; const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else { const s = await fs.stat(p, { bigint: true }); rows.push([path.relative(folder, p), digest(await fs.readFile(p)), String(s.size), String(s.mtimeNs)]); } } }; await walk(folder); return JSON.stringify(rows.sort()); };
    const before = await inventory(), ok1 = await verifyCandidate(opts), after = await inventory();
    o.pass = { result: ok1.report.result ?? 'PASS', readOnly: ok1.report.readOnly, files: ok1.report.files, compiledInputs: ok1.report.compiledInputs, compiledOutputs: ok1.report.compiledOutputs };
    assert.equal(ok1.report.readOnly, true); assert.equal(after, before, 'verifier must not change bytes/size/mtime');
    const rejects = async (label, fn, want) => { const e = await fn().then(() => null, x => x); o[label] = e ? e.code ?? String(e.message) : 'ACEPTADO'; assert.ok(e && (Array.isArray(want) ? want.includes(e.code) : e.code === want), `${label}: ${o[label]}`); };
    // tamper / missing / wrong trusted SHA
    await w('src/a.ts', 'export const value = 2;\n'); await rejects('fuente manipulada', () => verifyCandidate(opts), 'FILE_HASH_MISMATCH'); await w('src/a.ts', src);
    await fs.unlink(path.join(folder, 'out/a.js')); await rejects('compilado ausente', () => verifyCandidate(opts), 'MISSING_FILE'); await w('out/a.js', out);
    await rejects('SHA confiable distinto', () => verifyCandidate({ ...opts, expectedManifestSHA256: digest(Buffer.from('otro')) }), 'MANIFEST_HASH_MISMATCH');
    // list problems: path escape, duplicate JSON key
    const esc = manifestOf({ ...files, '../fuera.txt': digest(src) }); await w('m-escape.json', esc);
    await rejects('ruta con escape en la lista', () => verifyCandidate({ ...opts, manifest: 'm-escape.json', expectedManifestSHA256: digest(esc) }), ['PATH_ESCAPE', 'INVALID_RELATIVE_PATH', 'INVALID_FILE_LIST']);
    const dup = Buffer.from(manifest.toString().replace('{"files":{', `{"files":{"src/a.ts":"${digest(src)}",`)); await w('m-dup.json', dup);
    await rejects('clave duplicada en la lista', () => verifyCandidate({ ...opts, manifest: 'm-dup.json', expectedManifestSHA256: digest(dup) }), ['DUPLICATE_JSON_KEY', 'DUPLICATE_FILE']);
    // stale compiled output: output changed and re-pinned in manifest, build state still old
    const out2 = Buffer.from('export const value = 1;\n//# otro\n'); await w('out/a.js', out2); const stale = manifestOf({ ...files, 'out/a.js': digest(out2) }); await w('m-stale.json', stale);
    await rejects('compilado obsoleto frente al estado', () => verifyCandidate({ ...opts, manifest: 'm-stale.json', expectedManifestSHA256: digest(stale) }), 'COMPILED_OUTPUT_MISMATCH'); await w('out/a.js', out);
    await w('out/extra.js', 'x'); await rejects('salida compilada extra', () => verifyCandidate(opts), 'COMPILED_OUTPUT_SET_CHANGED'); await fs.unlink(path.join(folder, 'out/extra.js'));
    await w('src/b.ts', 'export const b = 1;\n'); await rejects('entrada compilada no declarada', () => verifyCandidate(opts), 'COMPILED_INPUT_SET_CHANGED'); await fs.unlink(path.join(folder, 'src/b.ts'));
    // namespace del revisor: extra file outside the list does not change identity
    await w('reviewer/otra-nota.md', 'más notas\n'); const ok2 = await verifyCandidate(opts); o.namespaceIndependiente = ok2.report.readOnly === true && ok2.report.sourceFingerprint === ok1.report.sourceFingerprint;
    assert.equal(o.namespaceIndependiente, true);
    // sidecar guards
    const side = path.join(folder, 'sidecars'); await fs.mkdir(side);
    await rejects('sidecar dentro del conjunto sellado', () => writeSidecar(ok2, { sidecar: path.join(folder, 'src', 'r.json'), sidecarRoot: path.join(folder, 'src') }), ['SIDECAR_COLLIDES_WITH_SEALED_SET', 'SIDECAR_OUTSIDE_AUTHORIZED_ROOT']);
    await w('sidecars/existente.json', 'no sobrescribir'); await rejects('sidecar sobre archivo existente', () => writeSidecar(ok2, { sidecar: path.join(side, 'existente.json'), sidecarRoot: side }), ['EEXIST']);
    assert.equal(await fs.readFile(path.join(side, 'existente.json'), 'utf8'), 'no sobrescribir'); o.existenteIntacto = true;
    const final = await verifyCandidate(opts); o.finalPass = final.report.readOnly === true; assert.equal(o.finalPass, true);
    o.durationMs = Math.round(performance.now() - started);
    console.log(JSON.stringify({ evidence: 'S10-VERIFIER', observed: o, failures: [] })); console.log('S10_P05_VERIFIER_PASS');
  } catch (e) { console.log(JSON.stringify({ evidence: 'S10-VERIFIER-PARCIAL', observed: o, error: String(e).slice(0, 500) })); throw e; } finally {
    const real = await fs.realpath(folder).catch(() => null);
    if (real && path.resolve(real) === path.resolve(folder) && path.dirname(path.resolve(folder)) === runtime && /^s10-p05-verifier-[a-f0-9]{24}$/.test(path.basename(folder))) { await fs.rm(folder, { recursive: true, force: false, maxRetries: 3 }); await receipt({ event: 'cleanup-complete', remaining: 0 }); }
    else await receipt({ event: 'cleanup-failed', reason: 'ownership check' });
  }
});
