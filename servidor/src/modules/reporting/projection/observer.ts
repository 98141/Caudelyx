import {BSON,Timestamp,type Db,type ChangeStream,type ChangeStreamDocument,type Document} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {collections,protectedCollections,originals,limits} from './catalog.js';
import {ProjectionCodec,copy,hash,mutation,orderedPaths,transactionId,unavailable,type Mutation} from './codec.js';
import type {ManifestHeader,ManifestChunk,ProjectionHead} from './store.js';

type Event=ChangeStreamDocument<Document>;
export interface Barrier {time:Timestamp;issued:number;id:string;epoch:number}
type Waiter={after:number;resolve:(barrier:Barrier)=>void;reject:(error:unknown)=>void;timer:NodeJS.Timeout};
type Group={id:string;events:Event[];bytes:number};
const transaction=(event:Event)=>'lsid' in event&&'txnNumber' in event&&event.lsid?.id!==undefined?
  transactionId(event.lsid.id,event.txnNumber):null;
const document=(event:Event):Document|null=>'fullDocument' in event?event.fullDocument??null:null;
const previous=(event:Event):Document|null=>'fullDocumentBeforeChange' in event?event.fullDocumentBeforeChange??null:null;
const namespace=(event:Event):string|undefined=>'ns' in event&&'coll' in event.ns?event.ns.coll:undefined;
// Mongo splits only at top-level event fields and returns fragments sequentially.
// Resume tokens remain opaque; their contents never determine grouping or time.
export class ProjectionFragments {
  private partial:{total:number;next:number;bytes:number;value:Document}|undefined;
  constructor(readonly additionalBytes:()=>number=()=>0){}
  reset(){this.partial=undefined;}
  feed(event:Document):Event|null{
    const split=event['splitEvent'] as {fragment:number;of:number}|undefined;
    if(!split){if(this.partial)return unavailable();return event as Event;}
    if(!Number.isInteger(split.fragment)||!Number.isInteger(split.of)||split.of<1||split.of>16)return unavailable();
    if(split.fragment===1){
      if(this.partial)return unavailable();
      this.partial={total:split.of,next:1,bytes:0,value:Object.create(null) as Document};
    }
    const state=this.partial;if(!state||state.total!==split.of||state.next!==split.fragment)return unavailable();
    state.bytes+=BSON.serialize(event).length;
    if(state.bytes+this.additionalBytes()>limits.pendingBytes)return unavailable();
    for(const [key,value]of Object.entries(event)){
      if(key==='splitEvent')continue;
      if(key==='_id'&&Object.hasOwn(state.value,key))continue;
      if(Object.hasOwn(state.value,key))return unavailable();
      // eslint-disable-next-line security/detect-object-injection -- Disjoint server event fields in an object with no prototype.
      state.value[key]=value;
    }
    state.next++;
    if(split.fragment<split.of)return null;
    const complete=state.value;this.partial=undefined;return complete as Event;
  }
}
export class ProjectionObserver {
  readonly instance=randomUUID();
  private stream:ChangeStream<Document,Event>|undefined;
  private running=false;
  private available=false;
  private tainted=false;
  private epoch=0;
  private seq=0;
  private originalEvents=0;
  private readonly permittedMaintenance=new Map<string,{nonce:string;operation:'BOOTSTRAP'|'REBUILD'}>();
  private timer:NodeJS.Timeout|undefined;
  private publishing=false;
  private loop:Promise<void>|undefined;
  private lastTime:Timestamp|undefined;
  private readonly pending=new Map<string,Group>();
  private readonly intentions=new Map<string,{issued:number;body:Document;acknowledged:boolean;observed?:Timestamp}>();
  private readonly waiters:Waiter[]=[];
  private latest:Barrier|undefined;
  private readonly fragments=new ProjectionFragments(()=>{let bytes=0;for(const group of this.pending.values())bytes+=group.bytes;return bytes;});
  failureReason:string|null=null;
  failureDetail:string|null=null;
  private readonly connectionFailed=()=>{if(this.running)this.closeGate('connection-interrupted');};
  private readonly connectionClosed=(event:{reason:string})=>{if(event.reason!=='idle')this.connectionFailed();};
  constructor(readonly db:Db,readonly codec:ProjectionCodec,readonly restoreEpoch:string){}
  get ready(){return this.running&&this.available&&!this.tainted;}
  permitBootstrap(transactionId:string,nonce:string,operation:'BOOTSTRAP'|'REBUILD'='BOOTSTRAP'){
    if(!this.running||this.available||this.tainted)return unavailable();
    this.permittedMaintenance.set(transactionId,{nonce,operation});
  }
  private closeGate(reason:string){
    this.tainted=true;this.available=false;this.failureReason=reason;this.epoch++;
    this.fragments.reset();
    for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(new Error('Projection unavailable: '+reason));}
  }
  async start(verifyBaseline:()=>Promise<void>){
    if(this.running)return unavailable();
    this.running=true;this.epoch++;this.available=false;
    this.db.client.on('serverHeartbeatFailed',this.connectionFailed);
    this.db.client.on('connectionPoolCleared',this.connectionFailed);
    this.db.client.on('connectionClosed',this.connectionClosed);
    const names=[...protectedCollections,collections.heads,collections.manifests,collections.barriers];
    this.stream=this.db.watch([{$match:{$or:[{'ns.coll':{$in:names}},
      {operationType:{$nin:['insert','update','replace','delete']}}]}},
      {$unset:'updateDescription'},{$changeStreamSplitLargeEvent:{}}],
      {showExpandedEvents:true,fullDocument:'required',fullDocumentBeforeChange:'required',maxAwaitTimeMS:100});
    try{
      await this.stream.tryNext();
      this.loop=this.consume();
      this.timer=setInterval(()=>{void this.tick();},limits.barrierPeriodMs);
      const before=await this.awaitBarrier(performance.now(),performance.now()+limits.requestMs,false);
      const revision=this.originalEvents;
      await verifyBaseline();
      const after=await this.awaitBarrier(performance.now(),performance.now()+limits.requestMs,false);
      if(this.tainted||this.originalEvents!==revision||after.epoch!==before.epoch)return unavailable();
      this.available=true;
    }catch(error){this.closeGate('baseline-or-stream');throw error;}
  }
  async stop(){
    this.running=false;this.available=false;this.epoch++;
    this.db.client.off('serverHeartbeatFailed',this.connectionFailed);
    this.db.client.off('connectionPoolCleared',this.connectionFailed);
    this.db.client.off('connectionClosed',this.connectionClosed);
    if(this.timer)clearInterval(this.timer);
    for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(new Error('Projection observer stopped'));}
    await this.stream?.close();await this.loop;
    while(this.publishing)await new Promise<void>(resolve=>setTimeout(resolve,5));
    this.pending.clear();this.intentions.clear();this.fragments.reset();
  }
  assertCertified(barrier:Barrier){if(!this.ready||barrier.epoch!==this.epoch)return unavailable();}
  async barrierAfter(after:number,deadline:number){return await this.awaitBarrier(after,deadline,true);}
  private async awaitBarrier(after:number,deadline:number,requireReady:boolean):Promise<Barrier>{
    if(this.tainted||!this.running||requireReady&&!this.ready)return unavailable();
    if(this.latest&&this.latest.issued>after&&this.latest.epoch===this.epoch)return this.latest;
    const remaining=deadline-performance.now();if(remaining<=0)return unavailable();
    return await new Promise<Barrier>((resolve,reject)=>{
      const waiter:Waiter={after,resolve,reject,timer:setTimeout(()=>{
        const index=this.waiters.indexOf(waiter);if(index>=0)this.waiters.splice(index,1);
        reject(new Error('Projection barrier deadline'));
      },remaining)};
      this.waiters.push(waiter);
    });
  }
  private async tick(){
    if(!this.running||this.tainted||this.publishing)return;
    this.publishing=true;
    try{
      const total=await this.db.collection(collections.barriers).estimatedDocumentCount();
      const stats=await this.db.command({collStats:collections.barriers});
      if(total>=limits.barrierMaxRows||Number(stats.size)>limits.barrierMaxBytes){this.closeGate('barrier-quota');return;}
      const id=this.instance+':'+(++this.seq),issued=performance.now();
      const body={_id:id,databaseName:this.db.databaseName,runtimeInstanceId:this.instance,seq:this.seq,nonce:randomUUID(),restoreEpoch:this.restoreEpoch,
        issuedAt:new Date(),expiresAt:new Date(Date.now()+limits.barrierTtlMs)};
      const intention={issued,body:copy(body),acknowledged:false} as {issued:number;body:Document;acknowledged:boolean;observed?:Timestamp};
      this.intentions.set(id,intention);
      await this.db.collection<Document&{_id:string}>(collections.barriers).insertOne({...body,mac:this.codec.seal('BARRIER',body)},{writeConcern:{w:'majority'}});
      intention.acknowledged=true;
      this.certifyBarrier(id);
    }catch{if(this.running)this.closeGate('barrier-publisher');}finally{this.publishing=false;}
  }
  private certifyBarrier(id:string){
    const intent=this.intentions.get(id);
    if(!intent?.acknowledged||!intent.observed||this.tainted||!this.running)return;
    this.intentions.delete(id);
    const barrier={id,issued:intent.issued,time:intent.observed,epoch:this.epoch};
    this.latest=barrier;
    // eslint-disable-next-line security/detect-object-injection -- Bounded numeric index into the internal waiter array.
    for(let i=this.waiters.length-1;i>=0;i--){const waiter=this.waiters[i]!;if(barrier.issued>waiter.after){this.waiters.splice(i,1);clearTimeout(waiter.timer);waiter.resolve(barrier);}}
  }
  private async consume(){
    try{
      while(this.running){const event=await this.stream!.tryNext();if(event){const complete=this.fragments.feed(event);if(complete)this.accept(complete);}}
    }catch(error){
      this.failureDetail=error instanceof Error?error.message:'Unknown stream error';
      if(this.running)this.closeGate('stream-error');
    }
  }
  private accept(event:Event){
    if(this.tainted)return;
    try{
      if(!('clusterTime' in event)||!event.clusterTime)return this.closeGate('missing-time');
      const time=event.clusterTime;
      if(this.lastTime&&time.lessThan(this.lastTime))return this.closeGate('stream-order');
      if(this.lastTime&&time.greaterThan(this.lastTime)){
        for(const group of this.pending.values())this.validate(group);
        this.pending.clear();
      }
      this.lastTime=time;
      if(!['insert','update','replace','delete'].includes(event.operationType))return this.closeGate('ddl-or-unknown-operation');
      const name=namespace(event);
      if(name===collections.barriers){
        if(event.operationType==='delete'){
          const before=previous(event);if(!before||!(before['expiresAt'] instanceof Date)||before['expiresAt'].getTime()>Date.now())return this.closeGate('unexpected-barrier-delete');
          return;
        }
        const row=document(event);if(event.operationType!=='insert'||!row)return this.closeGate('barrier-modification');
        const {mac,...body}=row;
        if(!this.codec.verify('BARRIER',body,mac)||body['databaseName']!==this.db.databaseName||body['restoreEpoch']!==this.restoreEpoch)return this.closeGate('barrier-authentication');
        const intent=this.intentions.get(String(body['_id']));
        if(body['runtimeInstanceId']!==this.instance)return;
        if(!intent||hash(intent.body)!==hash(body))return this.closeGate('barrier-intention');
        intent.observed=time;
        this.certifyBarrier(String(body['_id']));
        return;
      }
      if(name===undefined||!protectedCollections.has(name)&&name!==collections.heads&&name!==collections.manifests)return;
      if(originals.has(name))this.originalEvents++;
      const id=transaction(event);if(id===null)return this.closeGate('unmanifested-write');
      let group=this.pending.get(id);if(!group){group={id,events:[],bytes:0};this.pending.set(id,group);}
      group.events.push(event);group.bytes+=BSON.serialize(event).length;
      let count=0,bytes=0;for(const pending of this.pending.values()){count+=pending.events.length;bytes+=pending.bytes;}
      if(count>limits.pendingEvents||bytes>limits.pendingBytes)this.closeGate('observer-quota');
    }catch{this.closeGate('event-or-manifest-invalid');}
  }
  private validate(group:Group){
    const manifests=group.events.filter(e=>namespace(e)===collections.manifests);
    if(manifests.some(e=>e.operationType!=='insert'))return unavailable();
    const documents=manifests.map(document),headers=documents.filter(d=>d?.['kind']==='HEADER') as ManifestHeader[];
    if(headers.length!==1)return unavailable();
    const header=headers[0]!,{mac,...body}=header;
    if(header._id!==group.id||header.transactionId!==group.id||header['databaseName']!==this.db.databaseName||header.formatVersion!==1||!this.codec.verify('MANIFEST',body,mac))return unavailable();
    if(header.operation==='BOOTSTRAP'||header.operation==='REBUILD'){
      const permit=this.permittedMaintenance.get(group.id);
      if(this.available||!header.maintenanceNonce||permit?.nonce!==header.maintenanceNonce||permit.operation!==header.operation)return unavailable();
      this.permittedMaintenance.delete(group.id);
    }else if(header.operation!=='COMMAND'||header.maintenanceNonce!==null)return unavailable();
    const chunks=(documents.filter(d=>d?.['kind']==='CHUNK') as ManifestChunk[]).sort((a,b)=>a.part-b.part);
    if(chunks.length!==header.chunkHashes.length||chunks.length+1!==documents.length)return unavailable();
    const expected:Mutation[]=[];
    for(let i=0;i<chunks.length;i++){
      // eslint-disable-next-line security/detect-object-injection -- Bounded numeric index into authenticated chunk arrays.
      const chunk=chunks[i]!;
      // eslint-disable-next-line security/detect-object-injection -- Matching bounded index into the signed chunk hash list.
      if(chunk.part!==i||chunk.transactionId!==group.id||chunk._id!==group.id+':'+i||hash(chunk)!==header.chunkHashes[i])return unavailable();
      if(chunk.mutations.length>limits.chunkRows||Buffer.byteLength(JSON.stringify(chunk))>limits.chunkBytes)return unavailable();
      expected.push(...chunk.mutations);
    }
    if(expected.length!==header.mutationCount||hash(expected)!==header.mutationRoot)return unavailable();
    const actual:Mutation[]=[],heads:Event[]=[];
    for(const event of group.events){
      const name=namespace(event);if(name===collections.manifests)continue;
      if(name===collections.heads){heads.push(event);continue;}
      if(name===undefined||!protectedCollections.has(name))return unavailable();
      const before=previous(event),after=document(event);
      if(event.operationType==='insert'?(before!==null||after===null):event.operationType==='delete'?(before===null||after!==null):before===null||after===null)return unavailable();
      actual.push(mutation(name,before,after));
    }
    if(hash(orderedPaths(actual))!==hash(orderedPaths(expected)))return unavailable();
    if(heads.length!==header.heads.length||heads.length!==header.organizations.length)return unavailable();
    const seen=new Set<string>();
    for(const event of heads){
      const after=document(event) as ProjectionHead|null,before=previous(event);
      if(!after||seen.has(after._id)||after.organizationId!==after._id)return unavailable();seen.add(after._id);
      const {mac:signature,...headBody}=after;
      if(!this.codec.verify('HEAD',headBody,signature)||after['databaseName']!==this.db.databaseName||after.lastManifest!==group.id||after.restoreEpoch!==this.restoreEpoch)return unavailable();
      if((before===null?null:hash(before))!==header.previousHeads[after._id])return unavailable();
      const advertised=header.heads.find(h=>h._id===after._id);if(!advertised||hash(advertised)!==hash(after))return unavailable();
      if(after.previousManifest!==(before?.['lastManifest']??null))return unavailable();
    }
    if(hash([...seen].sort())!==hash(header.organizations)||Object.keys(header.previousHeads).length!==seen.size)return unavailable();
  }
}
