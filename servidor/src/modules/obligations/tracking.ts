import type {ClientSession,Document} from 'mongodb';
import {mutation,type Mutation} from './codec.js';
import {originals} from './catalog.js';
export interface WriteSet {mutations:Mutation[];books:Set<string>;latest:Map<string,number>}
export class ManagementTracking {
 readonly active=new WeakMap<ClientSession,WriteSet>();
 begin(s:ClientSession){this.active.set(s,{mutations:[],books:new Set(),latest:new Map()});}
 end(s:ClientSession){this.active.delete(s);}
 capture(s:ClientSession,name:string,before:Document|null,after:Document|null){
  const state=this.active.get(s);if(!state||!s.inTransaction()||!originals.has(name))throw Error('Unregistered management transaction');
  state.mutations.push(mutation(name,before,after));
  for(const row of [before,after])if(typeof row?.['bookId']==='string'){state.books.add(row['bookId']);const stamp=typeof row['recordedAt']==='string'?Date.parse(row['recordedAt']):0;if(Number.isFinite(stamp))state.latest.set(row['bookId'],Math.max(state.latest.get(row['bookId'])??0,stamp));}
 }
}
