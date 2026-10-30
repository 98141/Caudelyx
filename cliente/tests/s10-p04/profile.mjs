import {fileURLToPath} from 'node:url';
const server=fileURLToPath(new URL('../../../servidor/',import.meta.url));
process.chdir(server);
const {s10Profile}=await import('../../../servidor/dist-s10-p04/tests/s10-p04/profile.js');
const {world}=await import('../../../servidor/dist-s10-p04/tests/s10-p04/fixture.js');
export async function profile(){const group=await s10Profile();try{const f=await world(group,Date.now());return{group,f};}catch(e){await group.dispose();throw e;}}
