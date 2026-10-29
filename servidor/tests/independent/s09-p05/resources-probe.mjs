// S09-P05 exact-name resource probe (Claude), read-only: takes ONLY the database names and control folders registered in
// S09-P05-RESOURCES.jsonl by the own profile (reserved-before-create/created), checks them on the installed Mongo by exact-name filter
// (no prefix sweep, no access to caudelyx_dev/caudelyx_manual) and checks the control folders on disk.
/* eslint-disable security/detect-non-literal-fs-filename -- Only own folders registered in own receipts and validated under .runtime above. */
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
const log = path.resolve('../../Construccion/Sprints/S09/Evidencias/S09-P05-RESOURCES.jsonl');
const rows = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
const names = new Set(), folders = new Set(), runtime = path.resolve('.runtime');
for (const r of rows) { for (const n of r.databases ?? []) { if (!/^caudelyx_s08_p02_[a-f0-9]{24}(_external_(mail|security))?$/.test(n)) throw Error('Unexpected registered name'); names.add(n); }
  for (const p of [r.folder, r.mongoFolder]) if (p) { const a = path.resolve(p); if (!a.startsWith(runtime + path.sep)) throw Error('Unexpected registered folder'); folders.add(a); } }
const client = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0', { appName: 'S09_P05_PROBE', serverSelectionTimeoutMS: 5000 });
await client.connect();
try {
  const r = await client.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: [...names] } } }), hello = await client.db('admin').command({ hello: 1 });
  const count = e => rows.filter(x => x.event === e).length;
  console.log(JSON.stringify({ at: new Date().toISOString(), namesChecked: names.size, foldersChecked: folders.size, ownDatabasesPresent: r.databases.map(d => d.name), ownFoldersPresent: [...folders].filter(p => fs.existsSync(p)), created: count('created'), cleanupComplete: count('cleanup-complete'), cleanupFailed: count('cleanup-failed'), blocked: count('existing-resource-blocked'), replicaSet: hello.setName, writablePrimary: hello.isWritablePrimary }));
} finally { await client.close(); }
