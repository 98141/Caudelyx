// S08-P05-R01 exact-name resource probe (Claude): lists ONLY the 3 own R01 database names on the installed Mongo (filter by exact name, no
// prefix sweep, no access to caudelyx_dev/caudelyx_manual) and the own R01 control folder. Read-only.
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
const names = ['caudelyx_s08_p02_5696f34f71d7c977e4537538', 'caudelyx_s08_p02_5696f34f71d7c977e4537538_external_mail', 'caudelyx_s08_p02_5696f34f71d7c977e4537538_external_security'];
const client = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0', { appName: 'S08_P05_R01_PROBE', serverSelectionTimeoutMS: 5000 });
await client.connect();
try {
  const r = await client.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
  const hello = await client.db('admin').command({ hello: 1 });
  const control = 'C:/Users/Asus ExpertBook/Desktop/Desarrollo_MBT/Prestamos/Caudelyx/servidor/.runtime/s08-p05-r01-5696f34f71d7c977e4537538';
  console.log(JSON.stringify({ at: new Date().toISOString(), ownDatabasesPresent: r.databases.map(d => d.name), replicaSet: hello.setName, writablePrimary: hello.isWritablePrimary, ownControlFolderExists: fs.existsSync(control) }));
} finally { await client.close(); }
