/* eslint-disable security/detect-object-injection -- Driver methods, namespaces and session state are closed server catalogs. */
import {BSON,type Db,type ClientSession,type Document,type Collection,type Filter} from 'mongodb';
import {copy,encode,mutation,type Mutation,unavailable} from './codec.js';
import {protectedCollections} from './catalog.js';

export interface WriteSet {mutations:Mutation[];organizations:Set<string>}
const methods=new Set(['insertOne','insertMany','updateOne','updateMany','replaceOne','deleteOne','deleteMany',
  'findOneAndUpdate','findOneAndReplace','findOneAndDelete','bulkWrite']);
type NativeMethod=(...args:unknown[])=>Promise<Document>;
export class ProjectionTracking {
  readonly db:Db;
  enabled=false;
  readonly active=new WeakMap<ClientSession,WriteSet>();
  constructor(readonly raw:Db){
    const cache=new Map<string,Collection<Document>>();
    this.db=new Proxy(raw,{get:(target,property)=>{
      if(property==='collection')return(name:string,options?:Document)=>{
        if(!protectedCollections.has(name))return target.collection(name,options);
        if(options)return this.wrap(target.collection(name,options),name);
        let collection=cache.get(name);if(!collection){collection=this.wrap(target.collection(name),name);cache.set(name,collection);}return collection;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
  }
  begin(session:ClientSession){this.active.set(session,{mutations:[],organizations:new Set()});}
  end(session:ClientSession){this.active.delete(session);}
  private wrap(collection:Collection<Document>,name:string):Collection<Document>{
    return new Proxy(collection,{get:(target,property)=>{
      const value=Reflect.get(target,property,target);
      if(typeof value!=='function')return value;
      if(property==='find')return(filter:Document={},options:Document={})=>{
        // mongodb 7.7.0 does not propagate a withTransaction CSOT context to
        // cursors. Share that exact context so getMore omits server maxTimeMS
        // while retaining the single client deadline across every batch.
        const session=options['session'] as ClientSession|undefined;
        const context=session?Reflect.get(session,'timeoutContext'):undefined;
        return target.find(filter,context?{...options,timeoutContext:context}:options);
      };
      if(typeof property!=='string'||!methods.has(property))return value.bind(target);
      return async(...args:unknown[])=>{
        if(!this.enabled)return await (value as NativeMethod).apply(target,args);
        const optionIndex=['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace'].includes(property)?2:1;
        const options=args[optionIndex] as {session?:ClientSession}|undefined;
        const session=options?.session,state=session&&this.active.get(session);
        if(!session||!state||!session.inTransaction())return unavailable();
        const predicates:Document[]=[];
        if(property==='insertOne')predicates.push({_id:(args[0] as Document)['_id']});
        else if(property==='insertMany')for(const item of args[0] as Document[])predicates.push({_id:item['_id']});
        else if(property==='bulkWrite')for(const item of args[0] as Document[]){
          const [kind,model]=Object.entries(item)[0] as [string,Document];
          if(!['insertOne','updateOne','updateMany','replaceOne','deleteOne','deleteMany'].includes(kind))return unavailable();
          predicates.push(kind==='insertOne'?{_id:model['document']['_id']}:model['filter']);
        }else predicates.push(args[0] as Document);
        const simple=predicates.every(predicate=>Object.keys(predicate).length===1&&typeof predicate['_id']==='string');
        const explicitIds=predicates.filter(predicate=>typeof predicate['_id']==='string').map(predicate=>predicate['_id']);
        if((options as {upsert?:boolean})?.upsert&&explicitIds.length!==predicates.length)return unavailable();
        if(simple&&new Set(explicitIds).size!==explicitIds.length&&property==='bulkWrite')return unavailable();
        const before=new Map<string,Document>();
        const beforePredicates=simple?[{_id:{$in:explicitIds}}]:predicates;
        for(const predicate of beforePredicates){
          if('_id' in predicate&&predicate['_id']===undefined)return unavailable();
          for(const row of await target.find(predicate,{session}).toArray()){
            const key=encode(row['_id']);if(before.has(key)&&property==='bulkWrite')return unavailable();before.set(key,copy(row));
          }
        }
        const result=await (value as NativeMethod).apply(target,args);
        const ids=new Map<string,unknown>([...before.values()].map(row=>[encode(row['_id']),row['_id']]));
        for(const id of explicitIds)ids.set(encode(id),id);
        for(const predicate of simple?[]:predicates){
          // Include predicate results after an upsert, plus old IDs after scope/key changes.
          for(const row of await target.find(predicate,{session}).toArray())ids.set(encode(row['_id']),row['_id']);
        }
        if(result?.['upsertedId'])ids.set(encode(result['upsertedId']),result['upsertedId']);
        for(const id of Object.values(result?.['upsertedIds']??{}))ids.set(encode(id),id);
        const after=new Map<string,Document>();
        if(ids.size)for(const row of await target.find({_id:{$in:[...ids.values()]}} as Filter<Document>,{session}).toArray())after.set(encode(row['_id']),row);
        for(const key of new Set([...before.keys(),...after.keys()])){
          const previous=before.get(key)??null,next=after.get(key)??null;
          if(previous!==null&&next!==null&&Buffer.from(BSON.serialize(previous)).equals(BSON.serialize(next)))continue;
          state.mutations.push(mutation(name,previous,next));
          for(const row of [previous,next]){
            if(typeof row?.['organizationId']==='string')state.organizations.add(row['organizationId']);
            if(['loan_operation_books','financial_books','lending_merkle_orgs'].includes(name)&&typeof row?.['_id']==='string')state.organizations.add(row['_id']);
          }
        }
        return result;
      };
    }});
  }
}
