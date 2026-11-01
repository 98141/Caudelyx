import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Context} from '../identity/models.js';
import {AppError} from '../../shared/errors.js';
import {exchangeAuthority} from '../exchange/authority.js';
import {hash} from './codec.js';
import type {Authority} from './models.js';
export async function authority(identity:IdentityService,context:Context,params:Record<string,string>,s:ClientSession,consolidated=false):Promise<Authority>{
 const auth=await exchangeAuthority(identity,context,params,s,{consolidated});
 if(auth.actor.suspended||auth.actor.state!=='ACTIVE'||auth.scope.kind==='BUSINESS'&&!auth.business?.isT)throw new AppError(403,'ACCESS_DENIED');
 const key=hash([auth.actor._id,consolidated?'CONSOLIDATED':auth.scope.kind,auth.scope.bookId,auth.scope.ownerId]);
 return{scope:auth.scope,actorId:auth.actor._id,context:auth.context,binding:hash(['S12',auth.binding,consolidated]),consolidated,key};
}
