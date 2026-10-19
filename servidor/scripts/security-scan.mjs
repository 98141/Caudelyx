// Local secret-pattern scan, not a claim to detect every secret.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Fixed repository path; inspect Git's index, including already-tracked files ignored by .gitignore.
const repository = fileURLToPath(new URL('../../', import.meta.url));
const tracked = execFileSync('git', ['-C', repository, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
const forbidden = tracked.filter(path => /(?:^|\/)(?:\.runtime|node_modules|dist|build)\//i.test(path) ||
  /\.(?:pem|key|p12|pfx)$/i.test(path) || /(?:^|\/)\.env(?:$|\.)/i.test(path) && !/(?:^|\/)\.env\.example$/.test(path));
if (forbidden.length) throw new Error(`Forbidden tracked paths (${forbidden.length}): ${forbidden.join(', ')}`);
console.log(`Git tracked-path guard: ${tracked.length} files passed.`);
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{30,}/];
let scanned = 0;
async function scan(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await scan(path);
    else {
      scanned++;
      const text = await readFile(path, 'utf8');
      if (patterns.some(pattern => pattern.test(text))) throw new Error(`Potential secret in ${path}`);
    }
  }
}
await scan('src'); await scan('tests');
console.log(`Secret-pattern scan: ${scanned} source/test files passed (limited pattern coverage).`);
