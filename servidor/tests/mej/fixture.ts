import {after} from 'node:test';
import {mejProfile,password} from '../helpers/mej-profile.js';
export {password};
export {fundedSetup,setup,view} from '../operations/fixture.js';
let group:ReturnType<typeof mejProfile>|undefined;
export const profile=()=>group??=mejProfile();
after(async()=>{if(group)await(await group).dispose();});
export const errorCode=(code:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===code;
