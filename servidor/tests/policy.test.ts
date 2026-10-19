import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authorization } from '../src/shared/authorization.js';
import type { Identity } from '../src/modules/identity/models.js';

test('authorization hierarchy and boundaries deny cross-tenant, role union escalation and wrong scope/owner/assignment',()=>{
  // Pure policy tests, not runtime integration claims. Unused identity fields are not consulted by this policy.
  const actor={_id:'administrator',realm:'TENANT',organizationId:'org-one',roles:['A','O'],suspended:false} as Identity;
  const ordinary={...actor,_id:'ordinary',roles:['O']} as Identity;
  Authorization.target(actor,ordinary);Authorization.assign(actor,['O','L']);
  for(const target of [{...ordinary,organizationId:'org-two'},{...ordinary,roles:['T']},{...ordinary,roles:['A','L']},{...ordinary,_id:actor._id}])assert.throws(()=>Authorization.target(actor,target));
  for(const roles of [['T'],['SA'],['A'],['O','O'],[]])assert.throws(()=>Authorization.assign(actor,roles));
  const resource={organizationId:'org-one',financialScope:'BUSINESS',legalOwnerId:'owner',assigneeId:actor._id};
  const policy={scope:'BUSINESS' as const,legalOwnerIds:['owner'],assignmentRequired:true};
  Authorization.boundary(actor,resource,policy);
  for(const invalid of [{...resource,organizationId:'org-two'},{...resource,financialScope:'PERSONAL'},{...resource,legalOwnerId:'other'},{...resource,assigneeId:'other'}])assert.throws(()=>Authorization.boundary(actor,invalid,policy));
  assert.throws(()=>Authorization.boundary({...actor,realm:'PLATFORM'},resource,policy));
});
