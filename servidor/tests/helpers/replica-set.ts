import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { MongoClient } from 'mongodb';

export async function startReplicaSet(options: { manualProfile?: string; port?: number } = {}): Promise<{ uri: string; directory: string; stop: () => Promise<void> }> {
  const base = resolve('.runtime');
  await mkdir(base, { recursive: true });
  const profile = options.manualProfile;
  if (profile && profile !== 'manual' && !/^test-[a-f0-9-]{36}$/.test(profile)) throw new Error('Invalid local profile');
  const directory = profile ? join(base, profile === 'manual' ? 'manual-replica' : `manual-${profile}`) : await mkdtemp(join(base, 'replica-'));
  // Fixed runtime root + closed profile allowlist; never a request-provided path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(directory, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if ((await lstat(directory)).isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw new Error('Unsafe replica path');
  const port = options.port ?? await new Promise<number>((resolvePort, reject) => {
    const probe = createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      probe.close(() => resolvePort(address.port));
    });
  });
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 27017) throw new Error('Invalid isolated Mongo port');
  const binary = process.env['MONGOD_BINARY'] ?? 'C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe';
  let failure: Error | undefined;
  const repl = profile ? 'caudelyx-manual' : 'caudelyx-test';
  const processMongo: ChildProcess = spawn(binary, ['--replSet', repl, '--bind_ip', '127.0.0.1',
    '--port', String(port), '--dbpath', directory, '--logpath', join(directory, 'mongo.log'), '--quiet'],
  { windowsHide: true, stdio: 'ignore' });
  processMongo.on('error', error => { failure = error; });
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    if (processMongo.exitCode === null && processMongo.pid) await new Promise<void>((resolveExit, reject) => {
      const timeout = setTimeout(() => reject(new Error('Mongo shutdown timed out; directory retained')), 15000);
      processMongo.once('exit', () => { clearTimeout(timeout); resolveExit(); }); processMongo.kill();
    });
    if (!profile) {
      // Exact mkdtemp-owned directory, resolved inside .runtime and never a symlink.
      if (resolve(directory).startsWith(base + '\\') || resolve(directory).startsWith(base + '/')) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (!(await lstat(directory)).isSymbolicLink()) await rm(directory, { recursive: true, force: false, maxRetries: 3 });
      }
    }
  })();
  const direct = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 500 });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (failure) throw failure;
      if (processMongo.exitCode !== null) {
        // directory is created by mkdtemp under the fixed .runtime root, never request input.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        throw new Error(await readFile(join(directory, 'mongo.log'), 'utf8'));
      }
      try { await direct.connect(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); }
    }
    if (!ready) throw new Error('Local mongod did not become ready');
    const commandLine = await direct.db('admin').command({ getCmdLineOpts: 1 });
    const parsed = commandLine['parsed'] as {storage?:{dbPath?:string}};
    if (!parsed.storage?.dbPath || resolve(parsed.storage.dbPath) !== resolve(directory)) throw new Error('Mongo process does not own the expected synthetic directory');
    const existing = await direct.db('admin').command({ hello: 1 });
    if (!existing['setName']) await direct.db('admin').command({ replSetInitiate: { _id: repl, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    else if (existing['setName'] !== repl) throw new Error('Wrong replica set');
    for (let attempt = 0; attempt < 100; attempt++) {
      const hello = await direct.db('admin').command({ hello: 1 });
      if (hello['isWritablePrimary']) {
        await direct.close();
        return { uri: `mongodb://127.0.0.1:${port}/?replicaSet=${repl}`, directory, stop };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Replica set election timed out');
  } catch (error) { await direct.close(); await stop(); throw error; }
}
