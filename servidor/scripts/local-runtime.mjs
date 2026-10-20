// Local synthetic tooling only. Paths come from the fixed project root and a closed fixture profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
const exec = promisify(execFile);
export const serverRoot = path.resolve(import.meta.dirname, '..');
export const runtimeRoot = path.join(serverRoot, '.runtime');
export function profileName(value = process.env.CAUDELYX_DEV_TEST_PROFILE ?? 'manual') {
  if (value !== 'manual' && !/^test-[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid synthetic fixture profile');
  return value;
}
export function manualPaths() {
  const profile = profileName();
  return { profile, database: 'caudelyx_manual', mongoPort: profile === 'manual' ? 27181 : Number(process.env.CAUDELYX_DEV_TEST_MONGO_PORT),
    data: path.join(runtimeRoot, profile === 'manual' ? 'manual-replica' : `manual-${profile}`),
    control: path.join(runtimeRoot, profile === 'manual' ? 'manual-control' : `manual-control-${profile}`),
    descriptor: path.join(runtimeRoot, profile === 'manual' ? 'manual-connection.json' : `manual-${profile}-connection.json`) };
}
export function requireSyntheticMode() { if (process.env.CAUDELYX_MODE !== 'local-synthetic') throw new Error('CAUDELYX_MODE must be local-synthetic'); }
export function validateMongo(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'mongodb:' || u.username || u.password || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || !u.searchParams.get('replicaSet')) throw new Error('Only credential-free loopback replica sets allowed');
  return u;
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process owner');
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw new Error('Cannot verify process ownership'); }
}
export async function mongoProcesses() {
  if (process.platform !== 'win32') throw new Error('Process verification available only in this Windows local setup');
  // Only mongod dbpaths/PIDs leave PowerShell. Never enumerate/print Node worker command lines or credentials.
  const command = `$ErrorActionPreference='Stop'; $s=@(Get-CimInstance Win32_Service | Where-Object {$_.Name -match 'Mongo'}); $p=@(Get-CimInstance Win32_Process -Filter "Name='mongod.exe'" | ForEach-Object { $id=$_.ProcessId; $line=$_.CommandLine; if (!$line) {$line=($s | Where-Object {$_.ProcessId -eq $id} | Select-Object -First 1).PathName}; $m=[regex]::Match([string]$line,'--dbpath\\s+("[^"]+"|\\S+)'); $c=[regex]::Match([string]$line,'(?:--config|-f)\\s+("[^"]+"|\\S+)'); [pscustomobject]@{pid=$id;path=$m.Groups[1].Value.Trim('"');config=$c.Groups[1].Value.Trim('"')} }); ConvertTo-Json -InputObject $p -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 });
  const rows = JSON.parse(stdout || '[]');
  for (const row of rows) {
    if (!row.path && row.config) row.path = parse(await fs.readFile(row.config, 'utf8'))?.storage?.dbPath;
    if (typeof row.path !== 'string' || !path.isAbsolute(row.path)) throw new Error('Cannot verify Mongo process dbpath; cleanup stopped');
    delete row.config;
  }
  return rows;
}
export async function safeDirectory(p, prefix) {
  const absolute = path.resolve(p);
  if (path.dirname(absolute) !== runtimeRoot || !path.basename(absolute).startsWith(prefix)) throw new Error('Path outside authorized runtime scope');
  const s = await fs.lstat(absolute);
  if (!s.isDirectory() || s.isSymbolicLink() || path.resolve(await fs.realpath(absolute)) !== absolute) throw new Error('Unsafe directory/reparse point');
  return absolute;
}
export async function tlsProcesses() {
  const command = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter "Name='openssl.exe'" | ForEach-Object { $m=[regex]::Match([string]$_.CommandLine,'-keyout\\s+("[^"]+"|\\S+)'); if (!$m.Success) {throw 'Cannot verify TLS process ownership'}; [pscustomobject]@{pid=$_.ProcessId;file=$m.Groups[1].Value.Trim('"')} }); ConvertTo-Json -InputObject $p -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout || '[]').map(r => ({ pid: r.pid, path: path.dirname(path.resolve(r.file)) }));
}
export async function acquireRuntime() {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const lock = path.join(runtimeRoot, 'local-runtime.lock.json');
  try {
    const old = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (alive(old.pid)) throw new Error('Another local runtime owns TLS/ports; stop it first');
    await fs.unlink(lock);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fd = await fs.open(lock, 'wx', 0o600);
  await fd.writeFile(JSON.stringify({ pid: process.pid })); await fd.close();
  return async () => { const owner = JSON.parse(await fs.readFile(lock, 'utf8')); if (owner.pid !== process.pid) throw new Error('Runtime ownership changed'); await fs.unlink(lock); };
}
