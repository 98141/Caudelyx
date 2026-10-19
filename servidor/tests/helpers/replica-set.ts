import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { MongoClient } from 'mongodb';

export async function startReplicaSet(): Promise<{ uri: string; stop: () => Promise<void> }> {
  const base = resolve('.runtime');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'replica-'));
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      probe.close(() => resolvePort(address.port));
    });
  });
  const binary = process.env['MONGOD_BINARY'] ?? 'C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe';
  let failure: Error | undefined;
  const processMongo: ChildProcess = spawn(binary, ['--replSet', 'caudelyx-test', '--bind_ip', '127.0.0.1',
    '--port', String(port), '--dbpath', directory, '--logpath', join(directory, 'mongo.log'), '--quiet'],
  { windowsHide: true, stdio: 'ignore' });
  processMongo.on('error', error => { failure = error; });
  const stop = async () => {
    if (processMongo.exitCode !== null) return;
    await new Promise<void>(resolveExit => {
      processMongo.once('exit', () => resolveExit()); processMongo.kill();
    });
  };
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
    await direct.db('admin').command({ replSetInitiate: { _id: 'caudelyx-test', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    for (let attempt = 0; attempt < 100; attempt++) {
      const hello = await direct.db('admin').command({ hello: 1 });
      if (hello['isWritablePrimary']) {
        await direct.close();
        return { uri: `mongodb://127.0.0.1:${port}/?replicaSet=caudelyx-test`, stop };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Replica set election timed out');
  } catch (error) { await direct.close(); await stop(); throw error; }
}
