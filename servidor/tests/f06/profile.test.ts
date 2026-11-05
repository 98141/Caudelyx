import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../../src/shared/config.js';
test('legacy admission remains closed to remote/credentialed Mongo and public origins',()=>{
 const env={CAUDELYX_MODE:'local-synthetic',MONGODB_URI:'mongodb://127.0.0.1:27017/?replicaSet=rs0'};
 assert.equal(loadConfig(env).profile,undefined);
 for(const uri of ['mongodb://mongo:27017/?replicaSet=rs0','mongodb://u:p@127.0.0.1:27017/?replicaSet=rs0','mongodb://127.0.0.1:27017/'])assert.throws(()=>loadConfig({...env,MONGODB_URI:uri}));
 assert.throws(()=>loadConfig({...env,TENANT_ORIGIN:'https://example.com'}));
 assert.throws(()=>loadConfig({...env,CAUDELYX_MODE:'production'}));
 assert.throws(()=>loadConfig({...env,CAUDELYX_RUNTIME_PROFILE:'other'}));
});
