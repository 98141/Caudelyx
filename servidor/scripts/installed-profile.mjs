/* eslint-disable security/detect-non-literal-fs-filename -- Fixed operator-owned profile paths; never derived from HTTP input. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';

export const serverRoot = path.resolve(import.meta.dirname, '..');
export const projectRoot = path.resolve(serverRoot, '..');

export function validateInstalledUri(value) {
  const uri = new URL(value);
  if (uri.protocol !== 'mongodb:' || uri.username || uri.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) ||
      uri.port !== '27017' || !['', '/'].includes(uri.pathname)) {
    throw new Error('S02 requiere Mongo loopback:27017 sin credenciales ni base en la URI; no hay fallback.');
  }
  for (const key of uri.searchParams.keys()) if (key !== 'replicaSet') throw new Error('Opción Mongo no autorizada en el perfil S02.');
  if (uri.searchParams.getAll('replicaSet').length > 1) throw new Error('replicaSet duplicado.');
  return uri;
}

export function installedSettings(env = process.env) {
  if ((env.CAUDELYX_MODE ?? 'local-synthetic') !== 'local-synthetic') throw new Error('S02 solo permite local-synthetic.');
  const testId = env.CAUDELYX_DEV_TEST_ID;
  // Leave room for the existing _external_security namespace suffix (MongoDB limit).
  if (testId !== undefined && !/^[a-f0-9]{24}$/.test(testId)) throw new Error('Identificador de prueba inválido.');
  const s09=env.CAUDELYX_DEV_BUILD_SCOPE==='S09-P04',s10=env.CAUDELYX_DEV_BUILD_SCOPE==='S10-P04',s11=env.CAUDELYX_DEV_BUILD_SCOPE==='S11-P04';if((s09||s10||s11)&&!testId)throw new Error('Management test requires a registered temporary owner.');
  const database = testId ? s09||s10||s11?`caudelyx_s08_p02_${testId}`:`caudelyx_s02_test_${testId}` : 'caudelyx_dev';
  if (env.MONGODB_DATABASE !== undefined && env.MONGODB_DATABASE !== database) throw new Error('Base no autorizada para este perfil S02.');
  const mongoUri = env.MONGODB_URI ?? 'mongodb://localhost:27017';
  validateInstalledUri(mongoUri);
  const control = s09||s10||s11?path.join(serverRoot,'.runtime',(s11?'s11-p04-':s10?'s10-p04-':'s09-p04-')+testId):path.join(serverRoot, '.runtime', ...(testId ? ['installed-tests', testId] : ['installed-control']));
  const port = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < 1024 || n > 65535 || [27017, 27181].includes(n)) throw new Error('Puerto de aplicación inválido.');
    return n;
  };
  const uiPort = port(env.CAUDELYX_DEV_UI_PORT, 3001), apiPort = port(env.CAUDELYX_DEV_API_PORT, 4001), platformPort = port(env.CAUDELYX_DEV_PLATFORM_PORT, 3002);
  if (new Set([uiPort, apiPort, platformPort]).size !== 3) throw new Error('Los puertos de UI/API/plataforma deben ser distintos.');
  return { testId, database, mongoUri, control, descriptor: path.join(control, 'descriptor.json'),
    keyring: path.join(control, 'keys.json'), tls: path.join(control, 'tls'),
    uiPort, apiPort, platformPort, tenantOrigin: `https://localhost:${uiPort}`, platformOrigin: `https://platform.localhost:${platformPort}` };
}

export async function inspectInstalled(settings) {
  const uri = validateInstalledUri(settings.mongoUri);
  const client = new MongoClient(uri.href, { family: 4, serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (typeof hello.setName !== 'string' || !hello.isWritablePrimary || typeof hello.logicalSessionTimeoutMinutes !== 'number') {
      throw new Error('Mongo27017 debe ser primario de un replica set con sesiones; no se cambia el servicio ni se simulan transacciones.');
    }
    const requested = uri.searchParams.get('replicaSet');
    if (requested !== null && requested !== hello.setName) throw new Error('El replica set configurado no coincide con Mongo27017.');
    uri.searchParams.set('replicaSet', hello.setName);
    return { mongoUri: uri.href, replicaSet: hello.setName };
  } catch (error) {
    if (error instanceof Error && /replica set/.test(error.message)) throw error;
    throw new Error('Mongo27017 no disponible o no autorizado. Verifica el servicio y la configuración; no se usa otra base.');
  } finally { await client.close(); }
}

export async function readInstalledDescriptor(settings) {
  const descriptor = JSON.parse(await fs.readFile(settings.descriptor, 'utf8'));
  validateInstalledUri(descriptor.mongoUri);
  if (descriptor.mode !== 'local-synthetic' || descriptor.profile !== 'installed-s02' ||
      descriptor.databaseName !== settings.database || descriptor.keyringFile !== settings.keyring ||
      descriptor.tenantOrigin !== settings.tenantOrigin || !new URL(descriptor.mongoUri).searchParams.get('replicaSet')) {
    throw new Error('Descriptor S02 incompatible con el perfil/base/controles esperados.');
  }
  return descriptor;
}
