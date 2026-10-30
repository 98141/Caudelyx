import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {readFile,writeFile,appendFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {profile} from './profile.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),evidence=resolve(root,'../Construccion/Sprints/S10/Evidencias'),filename=join(evidence,'S10-P04-DEV.json'),started=performance.now();
const {ApiClient}=await import('../../../servidor/dist-s10-p04/tests/helpers/client.js');
const {installedSettings}=await import('../../../servidor/scripts/installed-profile.mjs');
let group,live,release;const record={task:'S10-P04',atUTC:new Date().toISOString(),result:'FAIL',command:'npm run dev',iterations:[],ownServiceOnly:true};
const sha=b=>createHash('sha256').update(b).digest('hex');
const free=async()=>{const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const a=s.address();await new Promise(r=>s.close(r));assert.ok(a&&typeof a!=='string'&&![27017,27181,3001,3002,4001].includes(a.port));return a.port;};
try{
 const setup=await profile();group=setup.group;const f=setup.f,id=group.folder.slice(-24),owner=JSON.parse(await readFile(join(group.folder,'owner.json'),'utf8')),date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(f.now()));record.groupId=id;
 const fund=await f.wealthMutate('businessCreateFund',{mode:'VIRTUAL',label:'Persistencia S10 P04',purpose:'SAVINGS',backingAccountId:f.bank.id,supportReference:'SYN'},{organizationId:f.org});await f.wealthMutate('businessAllocateFund',{bookETag:(await f.wealthRead('businessGetWealthBook',{organizationId:f.org},{asOf:date})).etag,effectiveDate:date,amount:'5000000.00',supportReference:'SYN'},{organizationId:f.org,fundId:fund.data.id},fund.etag);
 await f.restore.flush();await f.service.stop();await f.projection.stop();await f.database.close();
 const serialized={version:2,priority:f.keys.priority.toString('base64url'),mail:f.keys.mail.toString('base64url'),totp:f.keys.totp.toString('base64url'),journal:f.keys.journal.toString('base64url'),cursor:f.keys.cursor.toString('base64url')};await writeFile(join(group.folder,'keys.json'),JSON.stringify(serialized),{flag:'wx',mode:0o600});const keyHash=sha(await readFile(join(group.folder,'keys.json')));
 const ports=[];while(ports.length<3){const p=await free();if(!ports.includes(p))ports.push(p);}const[apiPort,uiPort,platformPort]=ports,origin='https://localhost:'+uiPort,done=join(group.folder,'s10-smoke.done'),env={...process.env,CAUDELYX_MODE:'local-synthetic',MONGODB_URI:'mongodb://127.0.0.1:27017/?replicaSet=rs0',MONGODB_DATABASE:group.names[0],CAUDELYX_DEV_TEST_ID:id,CAUDELYX_DEV_BUILD_SCOPE:'S10-P04',CAUDELYX_S10_OWNER_PID:String(process.pid),CAUDELYX_S10_OWNER_NONCE:owner.nonce,CAUDELYX_DEV_API_PORT:String(apiPort),CAUDELYX_DEV_UI_PORT:String(uiPort),CAUDELYX_DEV_PLATFORM_PORT:String(platformPort),CAUDELYX_DEV_SMOKE:'1'};
 assert.throws(()=>installedSettings({...env,CAUDELYX_DEV_TEST_ID:undefined}));assert.throws(()=>installedSettings({...env,MONGODB_DATABASE:'caudelyx_dev'}));assert.throws(()=>installedSettings({...env,MONGODB_URI:'mongodb://127.0.0.1:27181'}));record.protectedProfileNegatives='PASS: missing owner ID, persistent database and manual port rejected';
 const receipt=async data=>appendFile(join(evidence,'S10-P04-RESOURCES.jsonl'),JSON.stringify({at:new Date().toISOString(),task:'S10-P04',groupId:id,runId:owner.runId,...data})+'\n');
 class Client extends ApiClient{async call(method,path,body,headers={}){return super.call(method,path,body,{Host:'localhost:'+uiPort,Origin:origin,...headers});}}
 const npm=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 for(const iteration of [1,2]){
  const begin=performance.now();await receipt({event:'installed-npm-reserved-before-spawn',iteration,ports,databases:group.names});release=group.hold();live=spawn(process.execPath,[npm,'run','dev'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',ready=false;const ended=once(live,'exit');
  await receipt({event:'installed-npm-created',iteration,pid:live.pid,spawnfile:live.spawnfile,args:live.spawnargs,ownLiveHandle:true});
  const readiness=new Promise((resolveReady,reject)=>{const timer=setTimeout(()=>reject(Error('Own npm readiness deadline')),100000);const receive=b=>{output+=b.toString();if(output.length>1024*1024){clearTimeout(timer);reject(Error('Own npm log quota'));}if(!ready&&output.includes('S02 LOCAL SINTÉTICO:')){ready=true;clearTimeout(timer);resolveReady();}};live.stdout.on('data',receive);live.stderr.on('data',receive);live.once('error',e=>{clearTimeout(timer);reject(e);});live.once('exit',code=>{if(!ready){clearTimeout(timer);reject(Error('Own npm exited before ready '+code+' '+output.slice(-3500)));}});});
  await readiness;const cert=await readFile(join(group.folder,'tls/cert.pem')),api=new Client(apiPort,cert);api.cookies.set('__Host-caudelyx-session',f.a.issued.token);await api.refreshCsrf();
  const funds=await api.call('GET',`/api/v1/organizations/${f.org}/wealth-s10/funds?asOf=${date}`);assert.equal(funds.status,200,JSON.stringify(funds.body));assert.ok(funds.body.data.items.some(row=>row.id===fund.data.id&&row.reserved==='5000000.00'));
  const availability=await api.call('GET',`/api/v1/organizations/${f.org}/wealth-s10/availability?asOf=${date}&accountId=${f.bank.id}`);assert.equal(availability.status,200,JSON.stringify(availability.body));assert.equal(availability.body.data.free,'15000000.00');assert.equal(sha(await readFile(join(group.folder,'keys.json'))),keyHash);
  const ui=await new Promise((resolveUi,reject)=>{const req=request(origin,{ca:cert,servername:'localhost'},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolveUi({status:res.statusCode,body}));});req.on('error',reject);req.end();});assert.equal(ui.status,200);assert.match(ui.body,/<html/);
  await writeFile(done,'OWN-S10-SMOKE-COMPLETE',{flag:'wx'});const[exitCode]=await ended;assert.equal(exitCode,0,output.slice(-3000));live=null;release();release=null;await unlink(done);
  record.iterations.push({iteration,durationMs:performance.now()-begin,HTTPS:200,reserved:'5000000.00',free:'15000000.00',sameKeyring:true,exitCode,output});await receipt({event:'installed-npm-stopped',iteration,exitCode,ownHandlesOnly:true});
 }
 record.result='PASS';
}catch(e){record.error=String(e);record.stack=e.stack;console.error(e);process.exitCode=1;}
finally{
 if(live&&live.exitCode===null){await writeFile(join(group.folder,'s10-smoke.done'),'OWN-S10-ERROR-CLEANUP').catch(()=>{});await once(live,'exit');live=null;}if(release){release();release=null;}if(group)await group.dispose();record.durationMs=performance.now()-started;let data;try{data=JSON.parse(await readFile(filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;data={task:'S10-P04',runs:[]};}data.runs.push(record);await writeFile(filename,JSON.stringify(data,null,2)+'\n');
}
