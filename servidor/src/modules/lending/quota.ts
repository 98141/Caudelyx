import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import {AppError} from '../../shared/errors.js';
export async function quoteQuota(identity:IdentityService,actorId:string,organizationId:string,session:ClientSession){
  const window=Math.floor(identity.now()/60000),table=identity.database.db.collection<{_id:string;count:number;expiresAt:Date}>('lending_rate_windows');
  for(const [id,max]of [[`actor:${organizationId}:${actorId}:${window}`,30],[`org:${organizationId}:${window}`,60]] as const){
    const row=await table.findOne({_id:id},{session});if((row?.count??0)>=max)throw new AppError(429,'RATE_LIMITED');
    await table.updateOne({_id:id},{$inc:{count:1},$setOnInsert:{expiresAt:new Date((window+2)*60000)}},{session,upsert:true});
  }
}
