import assert from 'node:assert/strict';
import { assertOwnUri } from '../helpers/aj-onb-profile.js';
export function checkEnvironment(){
  for(const uri of ['mongodb://127.0.0.1:27017/?replicaSet=caudelyx-manual','mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual','mongodb://remote.invalid:30000/?replicaSet=caudelyx-manual','mongodb://127.0.0.1:30000/?replicaSet=rs0'])assert.throws(()=>assertOwnUri(uri));
  assert.doesNotThrow(()=>assertOwnUri('mongodb://127.0.0.1:35000/?replicaSet=caudelyx-manual'));
}
