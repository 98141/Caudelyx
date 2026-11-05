import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function regularFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(filename) !== path.resolve(filename)) {
    throw Error('Expected an ordinary file without symlink ancestors');
  }
  return fs.readFile(filename);
}
export function contractPath(root, relative) {
  if (!/^Construccion\/[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw Error('Unsafe contract path');
  }
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root, 'Construccion') + path.sep)) throw Error('Contract outside bundle');
  return absolute;
}
export async function verifyBundle(root, manifestPath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw Error('Explicit bundle manifest digest required');
  const bytes = await regularFile(manifestPath);
  if (sha256(bytes) !== expectedSha256) throw Error('Private manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid manifest');
  const seen = new Set();
  for (const item of manifest.files) {
    const filename = contractPath(root, item.path);
    if (seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes)) throw Error('Invalid manifest entry');
    seen.add(item.path);
    const file = await regularFile(filename);
    if (sha256(file) !== item.sha256 || file.length !== item.bytes) throw Error(`Contract bytes mismatch: ${item.path}`);
  }
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, {withFileTypes: true})) {
      const absolute = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw Error('Symlink in private bundle');
      if (entry.isDirectory()) await walk(absolute);
      else if (!entry.isFile() || !seen.has(path.relative(root, absolute).split(path.sep).join('/'))) throw Error('Unexpected private bundle file');
    }
  }
  await walk(path.join(root, 'Construccion'));
  return manifest;
}
