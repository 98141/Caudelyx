// TLS is required by mongosh CLI; credentials are read, never passed in argv.
try{
 const fs=require('fs'),admin=db.getSiblingDB('admin');
 if(!admin.auth(fs.readFileSync('/run/secrets/monitor_username','utf8').trim(),fs.readFileSync('/run/secrets/monitor_password','utf8').trim()))quit(1);
 const h=admin.runCommand({hello:1});
 quit(h.ok===1&&h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts?.length===1&&h.hosts[0]==='mongo:27017'?0:1);
}catch{quit(1);}
