/* eslint-disable security/detect-object-injection, security/detect-unsafe-regex -- Bounded UTF8 XML tokenizer; indexes follow input cursor bounds and own attribute maps. Declaration tokens are disjoint, no nested unbounded repetition; input20MiB and isolated10s budget. */
import {AppError} from '../../shared/errors.js';
import {checkBudget} from './budget.js';
export interface XmlNode {name:string;attrs:Record<string,string>;children:XmlNode[];text:string;namespaceURI?:string}
const reject=():never=>{throw new AppError(422,'FILE_ACTIVE_CONTENT');};
function decode(raw:string){
 return raw.replace(/&([^;]{1,16});/g,(_s,k:string)=>{
  const named:Record<string,string>={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};if(Object.hasOwn(named,k))return named[k]!;
  if(!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(k))return reject();const cp=k[1]==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10);if(cp===0||cp===0xfffe||cp===0xffff||cp>0x10ffff||cp>=0xd800&&cp<=0xdfff||cp<32&&![9,10,13].includes(cp))return reject();return String.fromCodePoint(cp);
 });
}
export function parseXml(bytes:Buffer,maxNodes=200000):XmlNode{
 let xml:string;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return reject();}
 if(xml.includes('<!')||/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(xml)||/&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9a-fA-F]+);)/.test(xml))reject();
 xml=xml.replace(/^\ufeff/,'').replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/i,'');
 if(xml.includes('<?'))reject();const stack:XmlNode[]=[],roots:XmlNode[]=[];let at=0,nodes=0;const start=performance.now();
 while(at<xml.length){
  if(nodes%1024===0)checkBudget();
  if(++nodes>maxNodes||stack.length>40)throw new AppError(413,'FILE_LIMIT_EXCEEDED');if(performance.now()-start>10000)throw new AppError(503,'FILE_BUDGET_EXCEEDED');
  if(xml[at]!=='<'){const end=xml.indexOf('<',at),next=end<0?xml.length:end,text=decode(xml.slice(at,next));if(!stack.length){if(text.trim())reject();}else stack.at(-1)!.text+=text;at=next;continue;}
  const match=/^<\/?([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(xml.slice(at));if(!match)reject();const name=match![1]!,closing=xml[at+1]==='/';let p=at+match![0].length;
  if(closing){while(/\s/.test(xml[p]??'')&&p<xml.length)p++;if(xml[p]!=='>')reject();if(stack.pop()?.name!==name)reject();at=p+1;continue;}
  const attrs:Record<string,string>=Object.create(null) as Record<string,string>;let self=false;
  while(true){while(p<xml.length&&/\s/.test(xml[p]!))p++;if(xml[p]==='>'){p++;break;}if(xml.slice(p,p+2)==='/>'){self=true;p+=2;break;}
   const a=/^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])/.exec(xml.slice(p));if(!a)reject();const key=a![1]!,quote=a![2]!;if(Object.hasOwn(attrs,key))reject();p+=a![0].length;const end=xml.indexOf(quote,p);if(end<0)reject();const raw=xml.slice(p,end);if(raw.includes('<')||raw.length>32768)reject();attrs[key]=decode(raw);p=end+1;
  }
  const node:XmlNode={name,attrs,children:[],text:''};if(stack.length)stack.at(-1)!.children.push(node);else roots.push(node);if(!self)stack.push(node);at=p;
 }
 if(stack.length||roots.length!==1)return reject();
 let namespaceNodes=0;const namespaces=(node:XmlNode,inherited:Map<string,string>)=>{
  if(++namespaceNodes%1024===0)checkBudget();const declarations=Object.entries(node.attrs).filter(([k])=>k==='xmlns'||k.startsWith('xmlns:')),scope=declarations.length?new Map(inherited):inherited;
  for(const[key,uri]of declarations){const prefix=key==='xmlns'?'':key.slice(6);if(prefix.includes(':')||prefix==='xmlns'||prefix==='xml'&&uri!=='http://www.w3.org/XML/1998/namespace'||uri==='http://www.w3.org/2000/xmlns/'||uri==='http://www.w3.org/XML/1998/namespace'&&prefix!=='xml'||prefix!==''&&uri==='')reject();scope.set(prefix,uri);}
  const resolve=(name:string,attribute=false)=>{const parts=name.split(':');if(parts.length>2)reject();if(parts.length===1)return(attribute?'':scope.get('')??'')+'|'+name;const uri=scope.get(parts[0]!);if(!uri)reject();return uri+'|'+parts[1];};
  node.namespaceURI=resolve(node.name).split('|')[0]!;const expanded=new Set<string>();for(const key of Object.keys(node.attrs)){if(key==='xmlns'||key.startsWith('xmlns:'))continue;const name=resolve(key,true);if(expanded.has(name))reject();expanded.add(name);}for(const child of node.children)namespaces(child,scope);
 };namespaces(roots[0]!,new Map([['xml','http://www.w3.org/XML/1998/namespace']]));return roots[0]!;
}
export const localName=(node:XmlNode)=>node.name.split(':').at(-1)!;
export const children=(node:XmlNode,name:string)=>node.children.filter(x=>localName(x)===name);
export const child=(node:XmlNode,name:string)=>children(node,name)[0];
export function descendants(node:XmlNode,name:string):XmlNode[]{return[...(localName(node)===name?[node]:[]),...node.children.flatMap(n=>descendants(n,name))];}
export const xmlEscape=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
