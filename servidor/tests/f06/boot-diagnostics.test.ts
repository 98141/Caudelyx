import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoServerError} from 'mongodb';
import {BootDiagnostics,safeBootCode,type BootStage} from '../../src/shared/boot-diagnostics.js';

test('boot diagnostics emit only closed stages/codes and preserve the error',async()=>{
  const lines:string[]=[],boot=new BootDiagnostics(line=>lines.push(line));
  const secret='mongodb://private-user:private-password@private-host/private-db?token=private-token';
  const error=Object.assign(new Error(secret),{code:'EACCES',path:'/private/keys.json'});
  await assert.rejects(boot.run('KEYRING',()=>{throw error;}),value=>value===error);
  assert.deepEqual(lines.map(line=>JSON.parse(line)),[
    {event:'CAUDELYX_BOOT',stage:'KEYRING',status:'START'},
    {event:'CAUDELYX_BOOT',stage:'KEYRING',status:'FAIL',code:'EACCES'},
  ]);
  assert.ok(lines.every(line=>!line.includes('private-')&&!line.includes('/private')));
});
test('nested failure reports the innermost stage once, not a raw Mongo message',async()=>{
  const lines:string[]=[],boot=new BootDiagnostics(line=>lines.push(line));
  const error=new MongoServerError({message:'secret index document and password',code:85});
  await assert.rejects(boot.run('RUNTIME',()=>boot.run('RUNTIME_FINANCE',()=>{throw error;})));
  const failures=lines.map(line=>JSON.parse(line) as {status:string;stage:string;code?:string}).filter(row=>row.status==='FAIL');
  assert.deepEqual(failures,[{event:'CAUDELYX_BOOT',stage:'RUNTIME_FINANCE',status:'FAIL',code:'MONGO_INDEX_OPTIONS_CONFLICT'}]);
  assert.ok(!lines.join('').includes('secret'));
});
test('unknown messages/codes, cycles and untrusted stage strings cannot leak',async()=>{
  assert.equal(safeBootCode(Object.assign(new Error('DEMO_SECRET_VALUE'),{code:'SECRET_VALUE'})),'UNCLASSIFIED');
  const circular:{cause?:unknown}={};circular.cause=circular;
  assert.equal(safeBootCode(circular),'UNCLASSIFIED');
  assert.equal(safeBootCode({cause:{code:'ERR_TLS_CERT_ALTNAME_INVALID',message:'private-host'}}),'ERR_TLS_CERT_ALTNAME_INVALID');
  const lines:string[]=[],boot=new BootDiagnostics(line=>lines.push(line));
  await assert.rejects(boot.run('private-stage' as BootStage,()=>0),/Invalid boot stage/);
  assert.equal(lines.length,0);
});
test('successful stages retain order and no payload is logged',async()=>{
  const lines:string[]=[],boot=new BootDiagnostics(line=>lines.push(line));
  const value={password:'never-logged'};assert.equal(await boot.run('CONFIG',()=>value),value);
  assert.deepEqual(lines.map(line=>JSON.parse(line).status),['START','OK']);
  assert.ok(!lines.join('').includes('never-logged'));
});
