import {inflateRawSync,deflateRawSync} from 'node:zlib';
import {AppError} from '../../shared/errors.js';
const limit=(code='FILE_LIMIT_EXCEEDED'):never=>{throw new AppError(code==='FILE_LIMIT_EXCEEDED'?413:422,code);};
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(data:Uint8Array){let c=0xffffffff;for(const b of data)c=(c>>>8)^crcTable[(c^b)&255]!;return(c^0xffffffff)>>>0;}
export interface ZipLimits {uploadBytes:number;expandedBytes:number;zipEntries:number;expansionRatio:number;timeMs:number}
const defaults:ZipLimits={uploadBytes:5242880,expandedBytes:20971520,zipEntries:256,expansionRatio:100,timeMs:10000};
export function readZip(bytes:Buffer,limits:ZipLimits=defaults):Map<string,Buffer>{
 const start=performance.now();if(bytes.length>limits.uploadBytes)limit();if(bytes.length<22||bytes.readUInt32LE(0)!==0x04034b50)limit('FILE_TYPE_REJECTED');
 const budget=()=>{if(performance.now()-start>limits.timeMs)throw new AppError(503,'FILE_BUDGET_EXCEEDED');};
 let eocd=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){eocd=i;break;}
 if(eocd<0)limit('FILE_TYPE_REJECTED');const end=eocd;
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))limit('FILE_TYPE_REJECTED');
 const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralOffset=bytes.readUInt32LE(end+16);if(count>limits.zipEntries)limit();if(!count||centralOffset+centralSize!==end)limit('FILE_TYPE_REJECTED');
 const result=new Map<string,Buffer>(),fold=new Set<string>(),spans:[number,number][]=[];let at=centralOffset,total=0,compressedTotal=0;
 const decode=(b:Buffer)=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return limit('FILE_TYPE_REJECTED');}};
 for(let i=0;i<count;i++){
  budget();if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)limit('FILE_TYPE_REJECTED');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),n=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42),attr=bytes.readUInt32LE(at+38);
  if(at+46+n+extra+comment>end||extra||flags&~0x808||![0,8].includes(method)||bytes.readUInt16LE(at+34)||(attr>>>16&0xf000)===0xa000)limit('FILE_ACTIVE_CONTENT');
  const nameBytes=bytes.subarray(at+46,at+46+n),name=decode(nameBytes);
  if(!name||name.length>240||/[\\:\x00-\x1f%]/.test(name)||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.'||p==='')||name!==name.normalize('NFC')||fold.has(name.toLowerCase()))limit('FILE_ACTIVE_CONTENT');
  fold.add(name.toLowerCase());if(size>limits.expandedBytes-total||size>Math.max(1,compressed)*limits.expansionRatio)limit();total+=size;compressedTotal+=compressed;
  if(offset+30>centralOffset||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method)limit('FILE_TYPE_REJECTED');
  const ln=bytes.readUInt16LE(offset+26),le=bytes.readUInt16LE(offset+28),dataStart=offset+30+ln+le,dataEnd=dataStart+compressed;
  if(le||dataEnd>centralOffset||!bytes.subarray(offset+30,offset+30+ln).equals(nameBytes))limit('FILE_TYPE_REJECTED');
  if(!(flags&8)&&(bytes.readUInt32LE(offset+14)!==crc||bytes.readUInt32LE(offset+18)!==compressed||bytes.readUInt32LE(offset+22)!==size))limit('FILE_TYPE_REJECTED');
  let spanEnd=dataEnd;
  if(flags&8){const signature=dataEnd+4<=centralOffset&&bytes.readUInt32LE(dataEnd)===0x08074b50?4:0;spanEnd=dataEnd+signature+12;if(spanEnd>centralOffset||bytes.readUInt32LE(dataEnd+signature)!==crc||bytes.readUInt32LE(dataEnd+signature+4)!==compressed||bytes.readUInt32LE(dataEnd+signature+8)!==size)limit('FILE_TYPE_REJECTED');}
  if(spans.some(([a,b])=>offset<b&&spanEnd>a))limit('FILE_TYPE_REJECTED');spans.push([offset,spanEnd]);
  let raw:Buffer;try{raw=method===0?Buffer.from(bytes.subarray(dataStart,dataEnd)):inflateRawSync(bytes.subarray(dataStart,dataEnd),{maxOutputLength:Math.min(size+1,limits.expandedBytes+1)});}catch{return limit();}
  if(raw.length!==size||crc32(raw)!==crc)limit('FILE_TYPE_REJECTED');result.set(name,raw);at+=46+n+extra+comment;
 }
 if(at!==end||total>Math.max(1,compressedTotal)*limits.expansionRatio)limit();spans.sort(([a],[b])=>a-b);let pos=0;for(const[a,b]of spans){if(a!==pos)limit('FILE_TYPE_REJECTED');pos=b;}if(pos!==centralOffset)limit('FILE_TYPE_REJECTED');return result;
}
export function writeZip(entries:Map<string,Buffer>,maxBytes=33554432){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const[name,raw]of entries){const nb=Buffer.from(name),data=deflateRawSync(raw,{level:6}),crc=crc32(raw),h=Buffer.alloc(30),c=Buffer.alloc(46);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(nb.length,26);local.push(h,nb,data);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(nb.length,28);c.writeUInt32LE(offset,42);central.push(c,nb);offset+=h.length+nb.length+data.length;if(offset>maxBytes)limit();
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);const result=Buffer.concat([...local,directory,end]);if(result.length>maxBytes)limit();return result;
}
