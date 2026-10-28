// Read-only final reconciliation of exactly the resources in this package's registry.
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MongoClient} from 'mongodb';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const evidence=resolve(root,'Construccion/Sprints/S08/Evidencias'),stem='S08-P02-PROJECTION-';
const records=(await readFile(resolve(evidence,stem+'RESOURCES.jsonl'),'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const databases=new Set(),paths=new Set(),groups=new Map();
for(const row of records){
  for(const name of [...(row.databases??[]),...(row.databasesRemoved??[]),...(row.database?[row.database]:[])]){
    assert.match(name,/^caudelyx_s08_(?:p02_[a-f0-9]{24}(?:_external_(?:mail|security))?|projection_(?:cap_[a-f0-9]{16}|test_[a-f0-9]{24}))$/);
    databases.add(name);
  }
  for(const path of [row.folder,row.mongoFolder])if(path){
    const absolute=resolve(path),base=resolve(root,'Caudelyx/servidor/.runtime');
    assert.ok(absolute.toLowerCase().startsWith((base+sep).toLowerCase()));paths.add(absolute);
  }
  const id=row.groupId??row.runId;
  if(id){const state=groups.get(id)??{id,created:false,cleanup:false,retained:[]};
    if(row.event==='created'){state.created=true;state.cleanup=false;}
    if(row.event==='cleanup-complete'){state.cleanup=true;state.retained=row.retained??[];}
    if(row.event==='cleanup-failed')state.cleanup=false;
    groups.set(id,state);
  }
}
assert.ok(databases.size>0);
const client=new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0',{appName:'S08_PROJECTION_RESOURCE_VERIFY',serverSelectionTimeoutMS:3000});
try{
  await client.connect();const hello=await client.db('admin').command({hello:1});assert.equal(hello.setName,'rs0');
  const remaining=await client.db('admin').command({listDatabases:1,filter:{name:{$in:[...databases]}},nameOnly:true});
  const controls=[];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read-only stat of exact registered owned paths, confined above to this workspace runtime root.
  for(const path of paths){try{await lstat(path);controls.push(path);}catch(error){if(error.code!=='ENOENT')throw error;}}
  const incomplete=[...groups.values()].filter(group=>group.created&&(!group.cleanup||group.retained.length));
  const status=remaining.databases.length===0&&controls.length===0&&incomplete.length===0?'PASS_OWNED_RESOURCES_REMOVED':'FAIL_OWNED_RESOURCES_REMAIN';
  const result={atUTC:new Date().toISOString(),status,groups:[...groups.values()],registeredDatabaseNames:[...databases].sort(),
    remainingDatabases:remaining.databases,registeredControlPaths:[...paths].sort(),remainingControls:controls,incompleteGroups:incomplete,
    createdGroups:[...groups.values()].filter(group=>group.created).length,retainedGroups:incomplete.length,
    sharedMongoServiceStopped:false,sharedEngineOplogOrPreimageHistoryErased:false,scope:'Owned database namespaces and controls; shared Mongo engine history is outside this teardown',
    maximumRecordedMongoStorageAndIndexesBytes:Math.max(0,...records.filter(row=>row.event==='cleanup-before').map(row=>row.mongoBytes??((row.storageSize??0)+(row.indexSize??0))))};
  await writeFile(resolve(evidence,stem+'RESOURCES-VERIFY.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({status,createdGroups:result.createdGroups,databasesChecked:databases.size,controlsChecked:paths.size,remainingDatabases:remaining.databases.length,remainingControls:controls.length,retainedGroups:incomplete.length}));
  assert.equal(status,'PASS_OWNED_RESOURCES_REMOVED');
}finally{await client.close();}
