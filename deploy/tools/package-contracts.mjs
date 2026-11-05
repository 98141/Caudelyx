// --inventory/--check are read-only. --pack COPIES private documents and must
// only be invoked after the owner's separate authorization. Never run in CI.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {regularFile, sha256, contractPath, verifyBundle} from '../api/verify-contracts.mjs';

// Literal product pins, NOT hashes adopted from the current document bytes.
// Each tuple also names the real reader that carries the expected digest.
const pins = [
  ['Sprints/S01/Evidencias/S01-P01-BASELINE-v0.9.json','d7bdc7f1023e043292315e048508aff73aa3d14ba829d87f053b1929d02d8935','shared/contract.ts'],
  ['Sprints/S01/Evidencias/S01-P04-v4-API-v0.11-CANDIDATE.json','95b913a919aab17952f955ec2083b69ff0c22dba410df17f4bc6dcaf0ef30b92','shared/contract.ts'],
  ['Sprints/S01/Evidencias/S01-P04-v2-API-ADDENDUM.json','2e08b418095b5c3dc15a57420f9374d1a846c2f386d815fa6cd8fb4d2e7caea8','shared/contract.ts'],
  ['Sprints/AJ-ONB/Contratos/openapi-auth-aj-onb-v1.json','d482383816f57103af9c0241a56874e55f3813789495df29f9e653c1d7946d21','shared/contract.ts'],
  ['Sprints/MEJ/Contratos/openapi-mej-v1.json','5117dfff76e24c21bad69acc37f45e2d3d94b3b1b69d514f0713e9c4d2456800','modules/sessions/work-policy.ts'],
  ['Sprints/S02/Contratos/openapi-finance-s02.yaml','e94743580b8ba587814d882bf492f636979bf76b6e96f46d3fd8a5b5db5dc729','modules/finance/contract.ts'],
  ['Sprints/S03/Contratos/openapi-opening-s03.json','51978d457cf3d4f1a3aea91ae7a8c7a5b2e2782dc3dea7a7475f314067e4f016','modules/opening/contract.ts'],
  ['Sprints/S11/Contratos/openapi-opening-s11-p02.json','50cbe18dd6b97b0f2838e563a0a4aa1391dca052c2c79e0d87759a59899ef5b8','modules/opening/contract.ts'],
  ['Sprints/S04/Contratos/openapi-lending-s04.json','f7b169834e83f403eb0b293a5ffa284f33434366af96e9d56c12dc799d467815','modules/lending/contract.ts'],
  ['Sprints/S05/Contratos/openapi-operations-s05.json','dd7d7f1c634b4c1b7c9498f62f9a99d06425da2d43081c3898517c79fb654be0','modules/lending/operations-contract.ts'],
  ['Sprints/S11/Contratos/openapi-operations-s11-p02.json','32e58e58f4d3be2896e9b76ec12e22be1766270da992b836ed0c5f9530f67452','modules/lending/operations-contract.ts'],
  ['Sprints/S07/Contratos/openapi-collections-s07-p02.json','e6c675ee2b258b61ff8c1182b36e319c5ed8893f5e407d9b9902e30b4f79325b','modules/payments/contract.ts'],
  ['Sprints/S11/Contratos/openapi-payments-s11-p02.json','9a5ff211ec8327385eeea82104001f90f059b29d258a5f6ff30180193fe9254c','modules/payments/contract.ts'],
  ['Sprints/S09/Contratos/openapi-expenses-s09-p04.json','573335da8e0b09f146cfb36209e1cf78538e8466d478c34f33eab49f7bc7c6b9','modules/obligations/contract.ts'],
  ['Sprints/S10/Contratos/openapi-reporting-s10-p02.json','9318e81fd1e8da3c78575c5737093287fba7d7b27249e9bdbb0de53eb2ef945f','modules/reporting/contract.ts'],
  ['Sprints/S10/Contratos/openapi-assets-s10-p02.json','c23703e1bd99b4dcf495cad7d5c819b92d325ea63c94715f9dff91119d22df45','modules/wealth/contract.ts'],
  ['Sprints/MODO-SIMPLE/Contratos/P01-v1/openapi-modo-simple-p01-approved.json','f3253ae506ee19f9215a0863ee0a0870d5599b5ad28c032fef254808dea3c1c1','modules/lending/ms-contract.ts'],
  ['Sprints/S11/Contratos/COLUMN_DICTIONARY_S11.json','e3db83426c8ed2482f142368fbc9aa8dc88fa6417dc785bb73f9c7ec11e898b7','modules/exchange/contract.ts'],
  ['Sprints/S11/Contratos/template-s11.schema.json','06fa04ecb7497183459d8a888173b7dff682cb53bb92a290321d2bdc921ba523','modules/exchange/contract.ts'],
  ['Sprints/S11/Evidencias/S11-P01-CONTRACT-HASHES.json','47fab524b76daa141756976a25614bb820a3b74d70ff1bc8a39b88eb87764f50','modules/exchange/contract.ts'],
  ['Sprints/S12/Contratos/openapi-import-export-s12-p02.json','26e5a39a5b4112fed3d16f60913009a89c390af8b32acd90f735540f9518ea3e','modules/exchange/contract.ts'],
  ['Sprints/S13/Contratos/openapi-simulation-alerts-s13-p01.json','9d73fa2cc8a78c05b5b0780676d35750c64c8eafa5398fa18a248b438b299dc7','modules/simulation/contract.ts'],
];

export async function inventory(workspace) {
  const root = path.resolve(workspace), files = new Map(), anchors = new Map();
  async function add(relative, expected, reason) {
    const bytes = await regularFile(contractPath(root, relative));
    if (sha256(bytes) !== expected) throw Error(`Pinned contract mismatch: ${relative}; no EOL repair or repinning`);
    const previous = files.get(relative);
    if (previous && previous.sha256 !== expected) throw Error('Conflicting contract pins');
    files.set(relative, {path: relative, sha256: expected, bytes: bytes.length, reason});
    return bytes;
  }
  for (const [relative, expected, reader] of pins) {
    const sourcePath = 'Caudelyx/servidor/src/' + reader;
    const source = await regularFile(path.join(root, sourcePath));
    if (!source.toString('utf8').includes(expected)) throw Error(`Product pin changed: ${sourcePath}`);
    anchors.set(sourcePath, {path: sourcePath, sha256: sha256(source), bytes: source.length});
    await add('Construccion/' + relative, expected, 'literal pin: ' + sourcePath);
  }
  // Runtime iterates ONLY sources; previous_baseline/review/validation links
  // in these manifests are provenance, not file reads. Do not copy them.
  for (const manifest of ['S01-P01-BASELINE-v0.9.json', 'S01-P04-v4-API-v0.11-CANDIDATE.json']) {
    const relative = 'Construccion/Sprints/S01/Evidencias/' + manifest;
    const bytes = await add(relative, files.get(relative).sha256, files.get(relative).reason);
    const data = JSON.parse(bytes);
    if (!Array.isArray(data.sources)) throw Error('Unexpected product manifest shape');
    for (const source of data.sources) await add(source.path, source.sha256, 'sources of ' + relative);
  }
  const templateManifest = 'Construccion/Sprints/S11/Evidencias/S11-P01-CONTRACT-HASHES.json';
  const templateHashes = JSON.parse(await regularFile(contractPath(root, templateManifest))).files;
  for (const name of ['caudelyx-import-template', 'opening-600', 'wealth-200m', 'negative-cases']) {
    const relative = 'Construccion/Sprints/S11/Plantillas/v1.0.0/' + name + '.xlsx';
    const bytes = await add(relative, templateHashes[relative], 'templateDownloads allowlist and ' + templateManifest);
    if (bytes.length > 131072) throw Error('Template exceeds product limit');
  }
  // Product WorkContract recursively loads $refs. Close that set read-only
  // through the existing YAML parser; never adopt an unpinned dependency.
  const {parse} = await import(pathToFileURL(path.join(root, 'Caudelyx/servidor/node_modules/yaml/dist/index.js')).href);
  for (const item of files.values()) {
    if (!/\.(?:json|yaml)$/.test(item.path)) continue;
    const data = parse((await regularFile(contractPath(root, item.path))).toString('utf8'));
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) {
        const ref = value.$ref.split('#')[0];
        if (/^[a-z]+:/i.test(ref) || ref.startsWith('/')) throw Error('Remote/absolute schema ref forbidden');
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(item.path), ref));
        if (!files.has(target)) throw Error(`Uninventoried schema dependency: ${target}`);
      }
      for (const child of Object.values(value)) visit(child);
    };
    // Old provenance manifests include URLs but no schema $refs; no links followed.
    visit(data);
  }
  return {schemaVersion: 1, scope: 'PRIVATE_RUNTIME_CONTRACTS_ONLY',
    files: [...files.values()].sort((a,b) => a.path < b.path ? -1 : 1),
    sourceAnchors: [...anchors.values()].sort((a,b) => a.path < b.path ? -1 : 1)};
}

export async function pack(workspace, output) {
  const root = path.resolve(workspace), dest = path.resolve(output);
  for (const forbidden of ['Caudelyx', 'Construccion']) {
    const folder = path.join(root, forbidden);
    if (dest === folder || dest.startsWith(folder + path.sep) || folder.startsWith(dest + path.sep)) throw Error('Private output must be outside code/documentation trees');
  }
  const parent = path.dirname(dest);
  if (await fs.realpath(parent) !== parent) throw Error('Private parent must exist without symlink ancestors');
  const manifest = await inventory(root); // Verify ALL pins before any write.
  await fs.mkdir(dest, {mode: 0o700}); // No recursive mkdir: never reuse/overwrite.
  for (const file of manifest.files) {
    const bytes = await regularFile(contractPath(root, file.path));
    if (sha256(bytes) !== file.sha256) throw Error('Source changed during packaging');
    const target = contractPath(dest, file.path);
    await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
    await fs.writeFile(target, bytes, {flag: 'wx', mode: 0o600});
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const manifestPath = path.join(dest, 'caudelyx-contracts.json');
  await fs.writeFile(manifestPath, bytes, {flag: 'wx', mode: 0o600});
  await verifyBundle(dest, manifestPath, sha256(bytes));
  return {files: manifest.files.length, manifestSha256: sha256(bytes)};
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, root, output, ...extra] = process.argv.slice(2);
    if (!root || extra.length || !['--inventory', '--check', '--pack'].includes(mode) || (mode === '--pack') !== Boolean(output)) throw Error('Usage: --inventory WORKSPACE | --check WORKSPACE | --pack WORKSPACE NEW_PRIVATE_OUTPUT');
    const result = mode === '--pack' ? await pack(root, output) : await inventory(root);
    console.log(JSON.stringify(mode === '--check' ? {files: result.files.length, bytes: result.files.reduce((n,f) => n+f.bytes,0), sourceAnchors: result.sourceAnchors.length, copied: 0} : result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
