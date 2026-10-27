import {collectionTables} from '../collections/models.js';
/* eslint-disable security/detect-object-injection -- Collection/index names and metadata paths originate from the closed domain tables below, never executable input. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {BSON,type ClientSession,type Collection,type Document} from 'mongodb';
import type {Database} from '../../shared/database.js';
import {AppError} from '../../shared/errors.js';
import {paymentCollections} from '../payments/models.js';
import {integrityFailure} from './verification.js';
type Row=Document&{_id:string};
export const domainCollections=['lending_borrowers','lending_borrower_versions','lending_field_schemas','lending_quotes','lending_loans','lending_loan_versions','lending_actions','lending_idempotency','lending_domain_state','loan_operation_books','loan_positions','loan_schedule_versions','loan_installments','loan_accruals','loan_events','loan_applications','borrower_credits','loan_operation_idempotency',...paymentCollections,...collectionTables] as const;
export async function initializeEvidenceIndexes(database:Database){for(const c of domainCollections)await database.db.collection(c).createIndex({organizationId:1,_id:1},{name:'lending_domain_org'});}
const countOptions=(c:string,s:ClientSession)=>({session:s,hint:c==='lending_domain_state'?'_id_':'lending_domain_org'});
export const maxEvidenceDepth=128;
export function assertEvidenceDepth(depth:number){if(!Number.isInteger(depth)||depth<1||depth>maxEvidenceDepth)integrityFailure();evidenceMetrics.maxDepthObserved=Math.max(evidenceMetrics.maxDepthObserved,depth);}
export interface Ref {id:string;hash:string;count:number;height:number}
interface Node extends Row {namespace:string;key:string;priority:string;data:IndexData;left:Ref|null;right:Ref|null;hash:string;count:number;height:number}
interface IndexData {id:string;collection:string;documentHash:string;meta:Record<string,string|number|boolean|null>}
interface Org extends Row {root:Ref|null;counts:Record<string,number>;revision:number}
export interface V2Head extends Row {format:'lending-v2';digest:string;revision:number;root:Ref|null;previousDigest:string;checkpointHash:string|null;mac?:string;priorityPolicy?:'HMAC-SHA256-v1';priorityKeyId?:string;priorityCheckpointHash?:string}
const credentials=new WeakMap<Database,{key:Buffer;priority?:Buffer;useHmac?:boolean;anchor?:{revision:number;digest:string}}>();
export function configureEvidenceKey(database:Database,key:Buffer,priority?:Buffer){const old=credentials.get(database);if(old&&(!old.key.equals(key)||Boolean(old.priority)!==Boolean(priority)||old.priority&&priority&&!old.priority.equals(priority)))throw Error('Evidence keys cannot change during a runtime');if(!old)credentials.set(database,{key,...(priority?{priority}:{}),useHmac:false});}
function selectPriority(database:Database,h:V2Head|null){const c=credentials.get(database);if(!c)throw new AppError(503,'SERVICE_UNAVAILABLE');if(h?.priorityPolicy){if(h.priorityPolicy!=='HMAC-SHA256-v1'||!c.priority||h.priorityKeyId!==createHash('sha256').update(c.priority).digest('hex'))integrityFailure();c.useHmac=true;}else c.useHmac=!h&&Boolean(c.priority);}
function priorityFields(database:Database){const c=credentials.get(database);return c?.useHmac&&c.priority?{priorityPolicy:'HMAC-SHA256-v1' as const,priorityKeyId:createHash('sha256').update(c.priority).digest('hex')}:{};}
function nodePriority(database:Database,namespace:string,key:string){const c=credentials.get(database);return c?.useHmac&&c.priority?createHmac('sha256',c.priority).update(JSON.stringify(['CAUDELYX:PRIORITY:v1',namespace,key])).digest('hex'):exactHash(key);}
export function anchorEvidence(database:Database,anchor:{format:string;revision:number;digest:string}|undefined){if(anchor?.format!=='lending-v2')return;const config=credentials.get(database);if(!config)throw Error('Evidence key unavailable');if(!config.anchor||anchor.revision>config.anchor.revision)config.anchor={revision:anchor.revision,digest:anchor.digest};else if(anchor.revision===config.anchor.revision&&anchor.digest!==config.anchor.digest)integrityFailure();}
const seal=(database:Database,digest:string)=>{const config=credentials.get(database);if(!config)throw new AppError(503,'SERVICE_UNAVAILABLE');return createHmac('sha256',config.key).update('CAUDELYX:LENDING-V2-HEAD:'+digest).digest('hex');};
function validHead(database:Database,h:V2Head){
  selectPriority(database,h);
  if(h.digest!==headDigest(h)||typeof h.mac!=='string'||!/^[0-9a-f]{64}$/.test(h.mac))return false;
  const expected=seal(database,h.digest),anchor=credentials.get(database)?.anchor;
  return timingSafeEqual(Buffer.from(h.mac,'hex'),Buffer.from(expected,'hex'))&&(!anchor||h.revision>anchor.revision||h.revision===anchor.revision&&h.digest===anchor.digest);
}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
export const exactHash=(v:unknown)=>{const serialized=JSON.stringify(canonical(BSON.EJSON.serialize(v,{relaxed:false})));if(evidenceMetrics.captureOrganizations){evidenceMetrics.hashCalls++;evidenceMetrics.hashBytes+=Buffer.byteLength(serialized);}return createHash('sha256').update(serialized).digest('hex');};
const ref=(n:Node):Ref=>({id:n._id,hash:n.hash,count:n.count,height:n.height});
const nodeHash=(n:Omit<Node,'hash'|'count'>)=>exactHash({namespace:n.namespace,key:n.key,priority:n.priority,data:n.data,left:n.left,right:n.right,height:n.height});
export const headDigest=(h:Omit<V2Head,'digest'>)=>exactHash({format:h.format,revision:h.revision,root:h.root,previousDigest:h.previousDigest,checkpointHash:h.checkpointHash,...(h.priorityPolicy?{priorityPolicy:h.priorityPolicy,priorityKeyId:h.priorityKeyId,priorityCheckpointHash:h.priorityCheckpointHash??null}:{})});
class Tree {
  readonly nodes;readonly cache=new Map<string,Node>();readonly dirty=new Map<string,Node|null>();
  constructor(readonly db:Database,readonly session:ClientSession|undefined,readonly namespace:string,public root:Ref|null){if(credentials.get(db)?.useHmac)this.namespace='hmac-v1:'+namespace;if(root)assertEvidenceDepth(root.height);this.nodes=db.db.collection<Node>('lending_merkle_nodes');}
  async load(r:Ref):Promise<Node>{
    assertEvidenceDepth(r.height);
    if(!this.cache.has(r.id))evidenceMetrics.indexNodesRead++;
    const n=this.cache.get(r.id)??await this.nodes.findOne({_id:r.id},this.session?{session:this.session}:{});
    if(!n||n.namespace!==this.namespace||n.hash!==r.hash||n.count!==r.count||n.height!==r.height||n.height!==1+Math.max(n.left?.height??0,n.right?.height??0)||n.count!==1+(n.left?.count??0)+(n.right?.count??0)||nodeHash(n)!==n.hash||n.priority!==nodePriority(this.db,this.namespace,n.key))integrityFailure();
    this.cache.set(r.id,n!);return n!;
  }
  save(n:Node){n.height=1+Math.max(n.left?.height??0,n.right?.height??0);assertEvidenceDepth(n.height);n.count=1+(n.left?.count??0)+(n.right?.count??0);n.hash=nodeHash(n);this.cache.set(n._id,n);this.dirty.set(n._id,n);return ref(n);}
  async rotate(r:Ref,left:boolean):Promise<Ref>{
    const p={...await this.load(r)},child={...await this.load((left?p.right:p.left)!)};
    if(left){p.right=child.left;child.left=this.save(p);}else{p.left=child.right;child.right=this.save(p);}return this.save(child);
  }
  async put(key:string,data:IndexData){
    const visit=async(r:Ref|null):Promise<Ref>=>{
      if(!r){const n:Node={_id:this.namespace+':'+exactHash(key),namespace:this.namespace,key,priority:nodePriority(this.db,this.namespace,key),data,left:null,right:null,count:1,height:1,hash:''};return this.save(n);}
      const n={...await this.load(r)};if(n.key===key){n.data=data;return this.save(n);}
      const left=key<n.key;if(left)n.left=await visit(n.left);else n.right=await visit(n.right);
      const updated=this.save(n),child=await this.load((left?n.left:n.right)!);return child.priority<n.priority||child.priority===n.priority&&child.key<n.key?await this.rotate(updated,!left):updated;
    };this.root=await visit(this.root);
  }
  async remove(key:string){
    const merge=async(l:Ref|null,r:Ref|null):Promise<Ref|null>=>{
      if(!l)return r;if(!r)return l;const a={...await this.load(l)},b={...await this.load(r)};
      if(a.priority<b.priority||a.priority===b.priority&&a.key<b.key){a.right=await merge(a.right,r);return this.save(a);}b.left=await merge(l,b.left);return this.save(b);
    };
    const visit=async(r:Ref|null):Promise<Ref|null>=>{if(!r)integrityFailure();const n={...await this.load(r!)};if(key===n.key){this.dirty.set(n._id,null);this.cache.delete(n._id);return await merge(n.left,n.right);}if(key<n.key)n.left=await visit(n.left);else n.right=await visit(n.right);return this.save(n);};
    this.root=await visit(this.root);
  }
  async get(key:string){let r=this.root;while(r){const n=await this.load(r);if(n.key===key)return n.data;r=key<n.key?n.left:n.right;}return null;}
  async *range(prefix:string,reverse=false,r:Ref|null=this.root):AsyncGenerator<IndexData>{
    if(!r)return;const n=await this.load(r),end=prefix+'\uffff';
    if(n.key>=prefix&&!reverse)yield* this.range(prefix,reverse,n.left);
    if(n.key<=end&&reverse)yield* this.range(prefix,reverse,n.right);
    if(n.key.startsWith(prefix))yield n.data;
    if(n.key<=end&&!reverse)yield* this.range(prefix,reverse,n.right);
    if(n.key>=prefix&&reverse)yield* this.range(prefix,reverse,n.left);
  }
  async flush(){
    if(!this.session)throw Error('Evidence writes require transaction');
    const ops=[...this.dirty].map(([id,n])=>n?{replaceOne:{filter:{_id:id},replacement:n,upsert:true}}:{deleteOne:{filter:{_id:id}}});
    if(ops.length)await this.nodes.bulkWrite(ops,{session:this.session,ordered:false});this.dirty.clear();
  }
}
const orderField=(c:string)=>c==='lending_borrowers'?'borrowerCode':c==='lending_field_schemas'?'schemaVersion':c==='lending_borrower_versions'?'profileVersion':c==='lending_loan_versions'?'termsVersion':c==='loan_installments'?'number':c==='loan_schedule_versions'?'version':c==='lending_actions'?'at':c==='loan_events'?'recordedAt':'createdAt';
const indexed=['borrowerCode','nameKey','borrowerId','loanId','quoteId','actorId','operation','purpose','key','receiptReference','schemaVersion','profileVersion','termsVersion','scheduleVersion','status','profile.document.number','openingBorrowerReference.referenceId'];
const encoded=(v:string|number|boolean|null)=>typeof v==='number'?'N'+String(v).padStart(20,'0'):'S'+Buffer.from(String(v),'utf8').toString('hex');
const primary=(c:string,id:string)=>c+'|P|'+id;
function dataFor(c:string,row:Row):IndexData{
  const meta:IndexData['meta']={_id:row._id};
  const collect=(v:unknown,p='')=>{if(v&&typeof v==='object'&&!Array.isArray(v))for(const[k,x]of Object.entries(v)){
    const field=p?p+'.'+k:k;if(x===null||['string','number','boolean'].includes(typeof x))meta[field]=x as string|number|boolean|null;else if(['profile','document','openingBorrowerReference'].includes(k))collect(x,field);
  }};collect(row);if(c==='lending_domain_state')meta['organizationId']=row._id;
  return{id:row._id,collection:c,documentHash:exactHash(row),meta};
}
function entries(d:IndexData):[string,IndexData][]{
  const sort=encoded(d.meta[orderField(d.collection)]??d.id)+'|'+d.id;
  return [[primary(d.collection,d.id),d],[d.collection+'|I|@all|'+sort,d],...indexed.filter(f=>d.meta[f]!==undefined).map(f=>[d.collection+'|I|'+f+'|'+encoded(d.meta[f]!)+'|'+sort,d] as [string,IndexData])];
}
function matches(filter:Document,meta:IndexData['meta']):boolean{
  for(const[k,v]of Object.entries(filter)){
    if(k==='$and'){if(!(v as Document[]).every(x=>matches(x,meta)))return false;continue;}
    if(k==='$or'){if(!(v as Document[]).some(x=>matches(x,meta)))return false;continue;}
    const x=meta[k];
    if(v&&typeof v==='object'){
      for(const[op,a]of Object.entries(v)){
        if(op==='$options')continue;
        if(op==='$ne'&&x===a)return false;if(op==='$in'&&!(a as unknown[]).includes(x))return false;
        if(op==='$gt'&&!(x!==undefined&&x!==null&&x>(a as string)))return false;
        if(op==='$gte'&&!(x!==undefined&&x!==null&&x>=(a as string)))return false;
        if(op==='$lt'&&!(x!==undefined&&x!==null&&x<(a as string)))return false;
        if(op==='$lte'&&!(x!==undefined&&x!==null&&x<=(a as string)))return false;
        // eslint-disable-next-line security/detect-non-literal-regexp -- Lending builds escaped literal search patterns; operators come from fixed server filters.
        if(op==='$regex'&&!(typeof x==='string'&&new RegExp(String(a),String((v as Document)['$options']??'')).test(x)))return false;
        if(!['$ne','$in','$gt','$gte','$lt','$lte','$regex'].includes(op))throw Error('Unsupported authenticated query operator');
      }
    }else if(x!==v)return false;
  }return true;
}
const units=new WeakMap<ClientSession,EvidenceUnit>();
const transactionId=(s:ClientSession)=>String(s.serverSession?.txnNumber??'unassigned');
export const evidenceMetrics={documentReads:0,indexNodesRead:0,documentWrites:0,captureOrganizations:false,hashCalls:0,hashBytes:0,maxDepthObserved:0,documentOrganizations:new Map<string,number>()};
export class EvidenceUnit {
  readonly transactionId:string;
  readonly tree:Tree;readonly global:Tree;readonly counted=new Set<string>();
  readonly readSet=new Map<string,string>();
  private changed=false;
  private constructor(readonly database:Database,readonly session:ClientSession,readonly org:Org,readonly head:V2Head|null){this.transactionId=transactionId(session);this.tree=new Tree(database,session,org._id,org.root);this.global=new Tree(database,session,'@global',head?.root??null);}
  static async open(database:Database,session:ClientSession,organizationId:string){
    const current=units.get(session);if(current&&current.transactionId===transactionId(session)){if(current.org._id!==organizationId)throw Error('A domain transaction cannot span organizations');return current;}units.delete(session);
    const head=await database.db.collection<V2Head>('lending_domain_state').findOne({_id:'evidence'},{session});
    if(head&&head.format!=='lending-v2')throw new AppError(503,'SERVICE_UNAVAILABLE');
    if(head&&!validHead(database,head))integrityFailure();
    const org=await database.db.collection<Org>('lending_merkle_orgs').findOne({_id:organizationId},{session});
    selectPriority(database,head);
    const unit=new EvidenceUnit(database,session,org??{_id:organizationId,root:null,counts:{},revision:0},head);
    const anchor=await unit.global.get('org|'+organizationId);
    if(org?(!anchor||anchor.documentHash!==exactHash(org)):anchor!==null)integrityFailure();
    if(!org){for(const c of domainCollections){const f=c==='lending_domain_state'?{_id:organizationId}:{organizationId};if(await database.db.collection<Row>(c).countDocuments(f,countOptions(c,session)))integrityFailure();}}
    units.set(session,unit);return unit;
  }
  async count(c:string){
    if(this.counted.has(c))return;const filter=c==='lending_domain_state'?{_id:this.org._id}:{organizationId:this.org._id};
    if(await this.database.db.collection<Row>(c).countDocuments(filter,countOptions(c,this.session))!==(this.org.counts[c]??0))integrityFailure();this.counted.add(c);
  }
  async read(c:string,id:string){
    if(evidenceMetrics.captureOrganizations)evidenceMetrics.documentOrganizations.set(this.org._id,(evidenceMetrics.documentOrganizations.get(this.org._id)??0)+1);
    await this.count(c);const committed=await this.tree.get(primary(c,id)),row=await this.database.db.collection<Row>(c).findOne({_id:id,...(c==='lending_domain_state'?{}:{organizationId:this.org._id})},{session:this.session});evidenceMetrics.documentReads++;
    if(!committed){if(row&&(row['organizationId']===this.org._id||c==='lending_domain_state'&&row._id===this.org._id))integrityFailure();this.readSet.set(primary(c,id),'ABSENT');return null;}
    if(!row||exactHash(row)!==committed.documentHash)integrityFailure();this.readSet.set(primary(c,id),committed.documentHash);return row;
  }
  async query(c:string,filter:Document,sort:Document={},limit=Infinity){
    await this.count(c);
    if(typeof filter['_id']==='string'){const row=await this.read(c,filter['_id']);return row&&matches(filter,dataFor(c,row).meta)?[row]:[];}
    const field=['key','receiptReference','quoteId','borrowerCode','loanId','borrowerId',...indexed].find(f=>filter[f]!==undefined&&filter[f]!==null&&typeof filter[f]!=='object');
    const prefix=field?c+'|I|'+field+'|'+encoded(filter[field])+'|':c+'|I|@all|';
    const requested=Object.keys(sort)[0],ordered=!requested||requested===orderField(c),reverse=ordered&&Object.values(sort)[0]===-1;
    const found:IndexData[]=[];
    for await(const d of this.tree.range(prefix,reverse)){if(matches(filter,d.meta)){found.push(d);if(ordered&&found.length>=limit)break;}}
    if(!ordered)found.sort((a,b)=>{for(const[k,dir]of Object.entries(sort)){const av=a.meta[k]??'',bv=b.meta[k]??'';if(av!==bv)return(av<bv?-1:1)*Number(dir);}return 0;});
    const rows=[];for(const d of found.slice(0,limit)){const row=await this.read(c,d.id);if(!row)integrityFailure();rows.push(row!);}return rows;
  }
  async track(c:string,before:Row|null,after:Row|null){
    if(before)for(const[k]of entries(dataFor(c,before)))await this.tree.remove(k);
    if(after)for(const[k,d]of entries(dataFor(c,after)))await this.tree.put(k,d);
    this.org.counts[c]=(this.org.counts[c]??0)+(after?1:0)-(before?1:0);this.changed=true;evidenceMetrics.documentWrites++;
  }
  async commit(){
    if(!this.changed)return;
    this.org.root=this.tree.root;this.org.revision++;
    await this.global.put('org|'+this.org._id,{id:this.org._id,collection:'@org',documentHash:exactHash(this.org),meta:{}});
    await this.tree.flush();await this.global.flush();
    await this.database.db.collection<Org>('lending_merkle_orgs').replaceOne({_id:this.org._id},this.org,{session:this.session,upsert:true});
    const next:V2Head={_id:'evidence',format:'lending-v2',revision:(this.head?.revision??0)+1,root:this.global.root,previousDigest:this.head?.digest??'',checkpointHash:this.head?.checkpointHash??null,...priorityFields(this.database),...(this.head?.priorityCheckpointHash?{priorityCheckpointHash:this.head.priorityCheckpointHash}:{}),digest:''};next.digest=headDigest(next);next.mac=seal(this.database,next.digest);
    const filter=this.head?{_id:'evidence',revision:this.head.revision,digest:this.head.digest}:{_id:'evidence',revision:{$exists:false}};
    const saved=await this.database.db.collection<V2Head>('lending_domain_state').replaceOne(filter,next,{session:this.session,upsert:!this.head});if(!saved.matchedCount&&!saved.upsertedCount)throw new AppError(409,'STATE_CONFLICT');this.changed=false;
  }
}
export const beginEvidence=(d:Database,s:ClientSession,org:string)=>EvidenceUnit.open(d,s,org);
export async function commitEvidence(_d:Database,s:ClientSession){await units.get(s)?.commit();}
export function domainCollection<T extends {_id:string}>(database:Database,name:typeof domainCollections[number]):Collection<T>{
  const raw=database.db.collection<Row>(name);
  const unit=async(s:ClientSession,filter:Document)=>{const u=units.get(s);return u&&u.transactionId===transactionId(s)?u:await beginEvidence(database,s,String(filter['organizationId']??(name==='lending_domain_state'?filter['_id']:'')));};
  return new Proxy(raw,{
    get(target,property){
      if(property==='findOne')return async(filter:Document={},options:Document={})=>options['session']?(await(await unit(options['session'],filter)).query(name,filter,options['sort']??{},1))[0]??null:await target.findOne(filter,options);
      if(property==='find')return(filter:Document={},options:Document={})=>{
        if(!options['session'])return target.find(filter,options);
        let sorting:Document={},limit=Infinity;const execute=async()=>await(await unit(options['session'],filter)).query(name,filter,sorting,limit);
        const cursor={sort:(value:Document)=>{sorting=value;return cursor;},limit:(value:number)=>{limit=value;return cursor;},toArray:execute,async *[Symbol.asyncIterator](){yield* await execute();}};return cursor;
      };
      if(['insertOne','replaceOne','updateOne','deleteOne'].includes(String(property)))return async(...args:unknown[])=>{
        const opt=(args[property==='insertOne'||property==='deleteOne'?1:2]??{}) as Document,s=opt['session'] as ClientSession|undefined;
        const method=Reflect.get(target,property,target) as (...a:unknown[])=>Promise<Document>;
        if(!s)return await method.apply(target,args);
        const u=await unit(s,args[0] as Document);let before:Row|null=null;
        if(property==='insertOne'){if(name==='lending_domain_state'?(args[0] as Row)._id!==u.org._id:(args[0] as Row)['organizationId']!==u.org._id)integrityFailure();}
        else args[0]={...(args[0] as Document),...(name==='lending_domain_state'?{_id:u.org._id}:{organizationId:u.org._id})};
        if(property==='insertOne'){await u.count(name);const id=(args[0] as Row)._id;if(await u.read(name,id))integrityFailure();}
        else before=(await u.query(name,args[0] as Document,{},1))[0]??null;
        const result=await method.apply(target,args);
        const id=property==='insertOne'?(args[0] as Row)._id:before?._id??result['upsertedId'];
        if(id){const after=property==='deleteOne'?null:await raw.findOne({_id:String(id)},{session:s});await u.track(name,before,after);}
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }
  }) as unknown as Collection<T>;
}

export async function verifyV2(database:Database,expected:{digest:string;revision:number}):Promise<boolean>{
  try{
    const h=await database.db.collection<V2Head>('lending_domain_state').findOne({_id:'evidence'});if(!h||h.format!=='lending-v2'||h.digest!==expected.digest||h.revision!==expected.revision||!validHead(database,h))return false;
    const global=new Tree(database,undefined,'@global',h.root),organizations=await database.db.collection<Org>('lending_merkle_orgs').find().toArray();
    let globalCount=0;for await(const entry of global.range('org|')){globalCount++;if(!organizations.some(o=>o._id===entry.id&&exactHash(o)===entry.documentHash))return false;}
    if(globalCount!==organizations.length)return false;
    for(const org of organizations){
      const tree=new Tree(database,undefined,org._id,org.root),expectedEntries=new Map<string,string>();
      for(const c of domainCollections){
        const filter=c==='lending_domain_state'?{_id:org._id}:{organizationId:org._id};const rows=await database.db.collection<Row>(c).find(filter).toArray();if(rows.length!==(org.counts[c]??0))return false;
        for(const row of rows)for(const[k,d]of entries(dataFor(c,row)))expectedEntries.set(k,exactHash(d));
      }
      const verify=async(r:Ref|null):Promise<boolean>=>{if(!r)return true;const n=await tree.load(r);if(expectedEntries.get(n.key)!==exactHash(n.data))return false;expectedEntries.delete(n.key);return await verify(n.left)&&await verify(n.right);};
      if(!await verify(tree.root)||expectedEntries.size)return false;
    }
    for(const c of domainCollections){const all=await database.db.collection<Row>(c).find(c==='lending_domain_state'?{_id:{$ne:'evidence'}}:{}).toArray();if(all.some(row=>!organizations.some(o=>o._id===(c==='lending_domain_state'?row._id:row['organizationId']))))return false;}
    if(h.checkpointHash){const checkpoint=await database.db.collection<Row>('lending_v2_checkpoint').findOne({_id:'legacy-v1'});if(!checkpoint||exactHash(checkpoint)!==h.checkpointHash)return false;}
    if(h.priorityCheckpointHash){const cp=await database.db.collection<Row>('lending_priority_checkpoint').findOne({_id:'hmac-v1'});if(!cp||exactHash(cp)!==h.priorityCheckpointHash)return false;}
    return true;
  }catch{return false;}
}

export async function migrateV2(database:Database,expected:{digest:string;revision:number},legacyDigest:(s:ClientSession)=>Promise<string>,maintenance?: (work:(s:ClientSession)=>Promise<void>)=>Promise<void>){
  const {verifyAllLoans}=await import('./verification.js');const {AuditWriter}=await import('../../shared/audit.js');
  await (maintenance??database.transaction.bind(database))(async session=>{
    const old=await database.db.collection<Row>('lending_domain_state').findOne({_id:'evidence'},{session});
    if(old?.['format']==='lending-v2')return;
    if(!old||old['digest']!==expected.digest||old['revision']!==expected.revision||await legacyDigest(session)!==expected.digest)integrityFailure();
    if(await database.db.collection('lending_merkle_orgs').countDocuments({},{session})||await database.db.collection('lending_merkle_nodes').countDocuments({},{session})||await database.db.collection('lending_v2_checkpoint').countDocuments({},{session}))integrityFailure();
    await verifyAllLoans(database,session);
    const groups=new Map<string,{org:Org;tree:Tree}>();
    for(const c of domainCollections){
      for await(const row of database.db.collection<Row>(c).find(c==='lending_domain_state'?{_id:{$ne:'evidence'}}:{},{session})){
        const id=String(c==='lending_domain_state'?row._id:row['organizationId']);if(!id||id==='undefined')integrityFailure();
        let g=groups.get(id);if(!g){g={org:{_id:id,root:null,counts:{},revision:1},tree:new Tree(database,session,id,null)};groups.set(id,g);}
        g.org.counts[c]=(g.org.counts[c]??0)+1;for(const[k,d]of entries(dataFor(c,row)))await g.tree.put(k,d);
      }
    }
    const global=new Tree(database,session,'@global',null);
    for(const {org,tree}of groups.values()){org.root=tree.root;await tree.flush();await database.db.collection<Org>('lending_merkle_orgs').insertOne(org,{session});await global.put('org|'+org._id,{id:org._id,collection:'@org',documentHash:exactHash(org),meta:{}});}
    await global.flush();
    const checkpoint={_id:'legacy-v1',format:'operations-v1',legacyDigest:expected.digest,legacyRevision:expected.revision,organizations:groups.size,root:global.root};
    await database.db.collection<Row>('lending_v2_checkpoint').insertOne(checkpoint,{session});
    const next:V2Head={_id:'evidence',format:'lending-v2',revision:expected.revision+1,root:global.root,previousDigest:expected.digest,checkpointHash:exactHash(checkpoint),digest:''};next.digest=headDigest(next);next.mac=seal(database,next.digest);
    const saved=await database.db.collection<V2Head>('lending_domain_state').replaceOne({_id:'evidence',digest:expected.digest,revision:expected.revision},next,{session});if(saved.matchedCount!==1)integrityFailure();
    await new AuditWriter(database).append({realm:'TENANT',actorId:'SYSTEM_LOCAL_TRANSITION',subjectId:'LENDING_V2',action:'LENDING_V2_VERIFIED_TRANSITION',outcome:'SUCCESS'},session);
  });
}

export async function migratePriorities(database:Database,expected:{digest:string;revision:number},maintenance?: (work:(s:ClientSession)=>Promise<void>)=>Promise<void>){
 const {AuditWriter}=await import('../../shared/audit.js');
 const old=await database.db.collection<V2Head>('lending_domain_state').findOne({_id:'evidence'});
 if(old?.priorityPolicy){if(!await verifyV2(database,expected))integrityFailure();return;}
 if(!old||!await verifyV2(database,expected))integrityFailure();
 const config=credentials.get(database);if(!config?.priority)throw new AppError(503,'SERVICE_UNAVAILABLE');
 try{await (maintenance??database.transaction.bind(database))(async session=>{
  const current=await database.db.collection<V2Head>('lending_domain_state').findOne({_id:'evidence'},{session});
  if(!current||current.digest!==expected.digest||current.revision!==expected.revision)integrityFailure();
  config.useHmac=true;
  const organizations=await database.db.collection<Org>('lending_merkle_orgs').find({},{session}).toArray(),global=new Tree(database,session,'@global',null);
  for(const previous of organizations){
   const tree=new Tree(database,session,previous._id,null),org:Org={_id:previous._id,root:null,counts:{},revision:previous.revision+1};
   for(const c of domainCollections)for await(const row of database.db.collection<Row>(c).find(c==='lending_domain_state'?{_id:org._id}:{organizationId:org._id},{session})){
    org.counts[c]=(org.counts[c]??0)+1;for(const[k,d]of entries(dataFor(c,row)))await tree.put(k,d);
   }
   org.root=tree.root;await tree.flush();await database.db.collection<Org>('lending_merkle_orgs').replaceOne({_id:org._id},org,{session});await global.put('org|'+org._id,{id:org._id,collection:'@org',documentHash:exactHash(org),meta:{}});
  }
  await global.flush();
  const checkpoint={_id:'hmac-v1',previous:old,nextRoot:global.root,policy:'HMAC-SHA256-v1',keyId:priorityFields(database).priorityKeyId};
  await database.db.collection<Row>('lending_priority_checkpoint').insertOne(checkpoint,{session});
  const next:V2Head={_id:'evidence',format:'lending-v2',revision:old!.revision+1,root:global.root,previousDigest:old!.digest,checkpointHash:old!.checkpointHash,priorityCheckpointHash:exactHash(checkpoint),...priorityFields(database),digest:''};next.digest=headDigest(next);next.mac=seal(database,next.digest);
  const saved=await database.db.collection<V2Head>('lending_domain_state').replaceOne({_id:'evidence',revision:old!.revision,digest:old!.digest},next,{session});if(saved.matchedCount!==1)integrityFailure();
  await new AuditWriter(database).append({realm:'TENANT',actorId:'SYSTEM_LOCAL_TRANSITION',subjectId:'PRIORITY_HMAC_V1',action:'PRIORITY_HMAC_VERIFIED_TRANSITION',outcome:'SUCCESS'},session);
 });}catch(e){config.useHmac=false;throw e;}
}
