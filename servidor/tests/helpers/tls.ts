import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
export async function testCertificate() {
  const base = resolve('.runtime'); await mkdir(base, { recursive: true });
  const folder = await mkdtemp(join(base, 'tls-'));
  try {
  await exec('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'), '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'], { windowsHide: true });
  // Paths are mkdtemp output inside fixed synthetic .runtime, not request data.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const key = await readFile(join(folder, 'key.pem'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const cert = await readFile(join(folder, 'cert.pem'));
  return { key, cert };
  } finally {
    // Delete only this helper's exact mkdtemp path, after buffers are read; active servers use the buffers.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!(await lstat(folder)).isSymbolicLink() && resolve(await realpath(folder)) === resolve(folder) && dirnameSafe(folder, base)) {
      await rm(folder, { recursive: true, force: false, maxRetries: 3 });
    }
  }
}
function dirnameSafe(folder: string, base: string): boolean { return resolve(folder, '..') === base && folder.slice(base.length + 1).startsWith('tls-'); }
