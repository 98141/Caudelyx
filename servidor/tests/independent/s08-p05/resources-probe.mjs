// S08-P05 exact-name resource probe (Claude): lists ONLY the 3 own database names on the installed Mongo (filter by exact name, no
// prefix sweep, no access to caudelyx_dev/caudelyx_manual), the own control folder and the protected listener set. Read-only.
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
const names = ['caudelyx_s08_p02_a5d08c1f3e7b49d2b86e0f15', 'caudelyx_s08_p02_a5d08c1f3e7b49d2b86e0f15_external_mail', 'caudelyx_s08_p02_a5d08c1f3e7b49d2b86e0f15_external_security'];
const client = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0', { appName: 'S08_P05_PROBE', serverSelectionTimeoutMS: 5000 });
await client.connect();
try {
  const r = await client.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
  const hello = await client.db('admin').command({ hello: 1 });
  const control = 'C:/Users/Asus ExpertBook/Desktop/Desarrollo_MBT/Prestamos/Caudelyx/servidor/.runtime/s08-p05-a5d08c1f3e7b49d2b86e0f15';
  console.log(JSON.stringify({ at: new Date().toISOString(), ownDatabasesPresent: r.databases.map(d => d.name), replicaSet: hello.setName, writablePrimary: hello.isWritablePrimary, ownControlFolderExists: fs.existsSync(control) }));
} finally { await client.close(); }
