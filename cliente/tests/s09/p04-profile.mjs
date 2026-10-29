import {fileURLToPath} from 'node:url';
const server=fileURLToPath(new URL('../../../servidor/',import.meta.url));process.chdir(server);
const {s09Profile}=await import('../../../servidor/dist-s09-backend/tests/s09-backend/profile.js');
const {world}=await import('../../../servidor/dist-s09-backend/tests/s09-backend/fixture.js');
export async function p04Profile(){const group=await s09Profile();try{return{group,f:await world(group,Date.now())};}catch(e){await group.dispose();throw e;}}
