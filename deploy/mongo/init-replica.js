// Explicit operator command. Localhost exception is used ONLY for the first
// admin of a fresh dedicated replica; existing users/passwords are never reset.
try{
 const fs=require('fs'),admin=db.getSiblingDB('admin'),secret=n=>fs.readFileSync('/run/secrets/'+n,'utf8').trim();
 let authenticated=false;try{authenticated=Boolean(admin.auth(secret('admin_username'),secret('admin_password')));}catch{}
 if(authenticated){const r=admin.runCommand({replSetGetConfig:1});if(r.ok!==1||r.config._id!=='rs0'||r.config.members.length!==1||r.config.members[0].host!=='mongo:27017')throw Error('TOPOLOGY_MISMATCH');}
 else{
  // replSetGetConfig is not granted by the localhost exception. Initiate is.
  try{const r=admin.runCommand({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}});if(r.ok!==1)throw r;}
  catch(e){if(e.code!==23)throw e;const r=admin.runCommand({replSetGetStatus:1});if(r.ok!==1||r.set!=='rs0'||r.members.length!==1||r.members[0].name!=='mongo:27017')throw Error('TOPOLOGY_MISMATCH');}
 }
 const deadline=Date.now()+60000;while(!admin.runCommand({hello:1}).isWritablePrimary){if(Date.now()>deadline)throw Error('PRIMARY_TIMEOUT');sleep(200);}
 if(!authenticated){admin.createUser({user:secret('admin_username'),pwd:secret('admin_password'),roles:[{role:'root',db:'admin'}]});if(!admin.auth(secret('admin_username'),secret('admin_password')))throw Error('ADMIN_AUTH_FAILED');}
 const principal=process.env.MONGODB_DATABASE;if(!/^caudelyx_demo_[a-z0-9_]{3,20}$/.test(principal??''))throw Error('DATABASE_REQUIRED');
 const appRoles=['','_external_mail','_external_security'].flatMap(s=>[{role:'readWrite',db:principal+s},{role:'dbAdmin',db:principal+s}]);
 for(const [name,roles] of [['app',appRoles],['monitor',[{role:'clusterMonitor',db:'admin'}]]]){
  const user=secret(name+'_username'),existing=admin.getUser(user);
  if(!existing)admin.createUser({user,pwd:secret(name+'_password'),roles,mechanisms:['SCRAM-SHA-256']});
  else{const normalized=r=>r.map(v=>v.db+':'+v.role).sort().join('|');if(normalized(existing.roles)!==normalized(roles))throw Error('EXISTING_ROLE_MISMATCH');}
 }
 print('DEMO_REPLICA_AND_USERS_INITIALIZED');
}catch{print('DEMO_MONGO_INIT_DENIED: inspect topology and operator credentials; no reset performed');quit(1);}
