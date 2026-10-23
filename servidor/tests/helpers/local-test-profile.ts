/* eslint-disable security/detect-non-literal-fs-filename -- Test-only fixed .runtime parent plus validated runId; no HTTP paths. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, realpath, rm, appendFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { MongoClient } from 'mongodb';

const defaultId=process.env['CAUDELYX_TEST_RUN_ID']??randomBytes(12).toString('hex');
const uri='mongodb://localhost:27017/?replicaSet=rs0';
const serverRoot=resolve(import.meta.dirname,'../../..'); // Compiled dist/tests/helpers module.
const root=join(serverRoot,'.runtime/installed-tests');
const protectedNames=new Set(['admin','config','local','caudelyx_dev','caudelyx_manual']);
export function testNames(id:string):string[] {
  if(!/^[0-9a-f]{24}$/.test(id))throw Error('A registered 24hex test runId is required');
  const base='caudelyx_s02_test_'+id;
  const names=[base,base+'_external_mail',base+'_external_security'];
  if(names.some(n=>protectedNames.has(n)||n.length>63))throw Error('Protected database');return names;
}
async function receipt(record:Record<string,unknown>) {
  const file=process.env['CAUDELYX_TEST_RESOURCE_LOG'];
  if(!file)throw Error('Test resource receipt path required before allocating databases');
  const evidence=resolve(serverRoot,'../../Construccion/Sprints/S02/Evidencias'),s3=resolve(serverRoot,'../../Construccion/Sprints/S03/Evidencias');
  const name=file.split(/[\\/]/).at(-1)??'';
  if(!(dirname(resolve(file))===evidence&&/^S02-P0[45]-[A-Z0-9-]+\.jsonl$/.test(name))&&!(dirname(resolve(file))===s3&&/^S03-P0[245]-[A-Z0-9-]+\.jsonl$/.test(name)))throw Error('Unowned resource log');
  await appendFile(file,JSON.stringify({at:new Date().toISOString(),...record})+'\n');
}
async function safeDirectory(directory:string,exists=true) {
  if(dirname(directory)!==root||!/^([0-9a-f]{24})$/.test(directory.slice(root.length+1)))throw Error('Outside test control root');
  if(exists&&(await realpath(directory)!==directory||(await lstat(directory)).isSymbolicLink()))throw Error('Control path is a link');
  // Verify resolved parents too, before creation/deletion. Never cross a junction into another workspace.
  if(await realpath(root)!==root||(await lstat(root)).isSymbolicLink())throw Error('Unsafe test root');
}
async function rejectLinks(directory:string):Promise<number> {
  let size=0;
  for(const row of await readdir(directory,{withFileTypes:true})) {
    const file=join(directory,row.name),stat=await lstat(file);
    if(stat.isSymbolicLink())throw Error('Refuse linked test tree');
    size+=row.isDirectory()?await rejectLinks(file):stat.size;
  }return size;
}
async function requireNoLiveLocks(directory:string) {
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.lock')&&n!=='test-owner.lock')) {
    const r=JSON.parse(await readFile(join(directory,name),'utf8')) as {pid?:number;payload?:{pid?:number}};
    const pid=r.pid??r.payload?.pid;if(!Number.isInteger(pid)||!pid||pid<1)throw Error('Unidentified lock owner');
    try {process.kill(pid,0);throw Error('Live fixture process');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  }
}
async function purge(directory:string,names:string[],id:string) {
  await safeDirectory(directory);await requireNoLiveLocks(directory);
  const controlBytes=await rejectLinks(directory);
  const client=new MongoClient(uri,{appName:'P04_TEST_CLEANUP',serverSelectionTimeoutMS:3000});
  await client.connect();
  try {
    const hello=await client.db('admin').command({hello:1});if(hello['setName']!=='rs0'||!hello['isWritablePrimary'])throw Error('Wrong local topology');
    const active=await client.db('admin').aggregate([
      {$currentOp:{allUsers:true,idleConnections:true,idleSessions:true}},
      {$match:{'clientMetadata.application.name':{$ne:'P04_TEST_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}},
      {$project:{_id:0,ns:1,active:1}}
    ]).toArray();
    if(active.length)throw Error('Fixture still has active/idle database consumers');
    const listed=await client.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
    const existing=(listed['databases'] as {name:string}[]).map(d=>d.name);
    let mongoBytes=0,dataSize=0,storageSize=0,indexSize=0;
    for(const name of existing) {
      if(!testNames(id).includes(name))throw Error('Outside exact test group');
      const stats=await client.db(name).command({dbStats:1});dataSize+=Number(stats['dataSize']);storageSize+=Number(stats['storageSize']);indexSize+=Number(stats['indexSize']);mongoBytes+=Number(stats['storageSize'])+Number(stats['indexSize']);
    }
    await receipt({event:'cleanup-before',runId:id,databases:existing,mongoBytes,dataSize,storageSize,indexSize,controlBytes,overBudget:mongoBytes>134217728||controlBytes>16777216});
    for(const name of existing)await client.db(name).command({dropDatabase:1,writeConcern:{w:'majority'}});
    const after=await client.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
    if((after['databases'] as unknown[]).length)throw Error('Database cleanup incomplete');
  }finally{await client.close();}
  await safeDirectory(directory);await rejectLinks(directory);
  await rm(directory,{recursive:true,force:false,maxRetries:3});
  await receipt({event:'cleanup-complete',runId:id,databases:names,remaining:0,controlRemoved:true});
}
export async function localTestProfile(id=defaultId) {
  const names=testNames(id),directory=join(root,id),nonce=randomUUID();
  // Receipt establishes exact ownership BEFORE any databases or controls are created.
  await receipt({event:'reserve',runId:id,databases:names,directory,ownerPid:process.pid,budget:{groups:1,databases:3,mongoBytes:134217728,controlBytes:16777216}});
  await mkdir(root,{recursive:true});await safeDirectory(directory,false);
  await mkdir(directory); // Existing groups are not guessed safe or silently adopted.
  const owner={runId:id,databases:names,nonce,pid:process.pid,kind:'local-synthetic-test'};
  await writeFile(join(directory,'test-owner.lock'),JSON.stringify(owner),{flag:'wx',mode:0o600});
  let disposed=false;
  return{runId:id,names,directory,database:names[0]!,uri,
    async dispose(){
      if(disposed)return;
      const actual=JSON.parse(await readFile(join(directory,'test-owner.lock'),'utf8')) as typeof owner;
      if(actual.nonce!==nonce||actual.pid!==process.pid||actual.runId!==id||JSON.stringify(actual.databases)!==JSON.stringify(names))throw Error('Test ownership changed');
      try{await purge(directory,names,id);disposed=true;}catch(error){await receipt({event:'cleanup-failed',runId:id,databases:names,reason:'guard-or-storage-failure',retainUntil:new Date(Date.now()+86400000).toISOString(),ownerPid:process.pid});throw error;}
    }};
}

export async function cleanupRetiredP03(expectedHash:string):Promise<void> {
  const file=resolve(serverRoot,'../../Construccion/Sprints/S02/Evidencias/S02-P03-RUNS.json'),bytes=await readFile(file);
  if(createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw Error('Retired P03 proof changed');
  const proof=JSON.parse(bytes.toString()) as {profile:{testId:string;confirmedDownAt:string}};
  if(!proof.profile.confirmedDownAt||proof.profile.testId!=='eddc20e2f466a34e2369ce36')throw Error('Unrecognized retired profile');
  const id=proof.profile.testId,names=testNames(id),directory=join(root,id);
  const descriptor=JSON.parse(await readFile(join(directory,'descriptor.json'),'utf8')) as {databaseName:string;mode:string;profile:string;mongoUri:string};
  const source=new URL(descriptor.mongoUri);
  if(descriptor.databaseName!==names[0]||descriptor.mode!=='local-synthetic'||descriptor.profile!=='installed-s02'||source.hostname!=='localhost'||source.port!=='27017')throw Error('Retired descriptor mismatch');
  await receipt({event:'retired-p03-cleanup-reserved',runId:id,databases:names,directory,proofSha256:expectedHash});
  await purge(directory,names,id);
}

// Recovery of THIS recorded run only after a failed setup/cancel. A dead original
// owner plus exact owner-file hash and the normal storage/lease guards are required.
export async function cleanupRecordedProfile(id:string,expectedOwnerHash:string):Promise<void>{
  const names=testNames(id),directory=join(root,id);await safeDirectory(directory);
  const bytes=await readFile(join(directory,'test-owner.lock'));
  if(createHash('sha256').update(bytes).digest('hex')!==expectedOwnerHash)throw Error('Recorded owner changed');
  const owner=JSON.parse(bytes.toString('utf8')) as {runId:string;databases:string[];pid:number;kind:string;nonce:string};
  if(owner.runId!==id||JSON.stringify(owner.databases)!==JSON.stringify(names)||owner.kind!=='local-synthetic-test'||!owner.nonce||!Number.isInteger(owner.pid)||owner.pid<1)throw Error('Unproven recorded owner');
  try{process.kill(owner.pid,0);throw Error('Recorded owner is still live');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  await receipt({event:'recorded-profile-recovery',runId:id,databases:names,directory,ownerFileSha256:expectedOwnerHash});
  await purge(directory,names,id);
}
