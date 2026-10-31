/* eslint-disable security/detect-object-injection -- Closed template headers and decoded cell maps; never executed as code. */
import {readZip} from './zip.js';
import {parseXml,localName,children,child,descendants,type XmlNode} from './xml.js';
import {dictionary,exchangeContract} from './contract.js';
import {AppError} from '../../shared/errors.js';
import type {WorkbookData,Data,Issue} from './models.js';
const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRel='http://schemas.openxmlformats.org/officeDocument/2006/relationships',packageRel='http://schemas.openxmlformats.org/package/2006/relationships',contentNS='http://schemas.openxmlformats.org/package/2006/content-types';
const rootNamespace=(n:XmlNode)=>n.namespaceURI;
const active=():never=>{throw new AppError(422,'FILE_ACTIVE_CONTENT');};
export function columnName(n:number){let a='';for(;n;n=Math.floor((n-1)/26))a=String.fromCharCode(65+(n-1)%26)+a;return a;}
function address(v:string){const a=/^([A-Z]{1,2})([1-9][0-9]{0,6})$/.exec(v);if(!a)return active();let col=0;for(const c of a[1]!)col=col*26+c.charCodeAt(0)-64;const row=Number(a[2]);if(col>32||row>1001)throw new AppError(413,'FILE_LIMIT_EXCEEDED');return{col,row};}
const text=(n:XmlNode)=>descendants(n,'t').map(x=>x.text).join('');
export interface ParsedWorkbook {data:WorkbookData;issues:Issue[];rows:number;cells:number;expandedBytes:number}
export function parseWorkbook(bytes:Buffer):ParsedWorkbook{
 const started=performance.now(),parts=readZip(bytes),documents=new Map<string,XmlNode>(),dict=dictionary(),data:WorkbookData=Object.fromEntries(dict.sheets.map(s=>[s.name,[]])),issues:Issue[]=[];let cells=0,rows=0;
 for(const[name,raw]of parts){
  if(!/^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:app|core)\.xml|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/(?:styles|sharedStrings)\.xml|xl\/theme\/theme[0-9]+\.xml|xl\/worksheets\/sheet[0-9]+\.xml)$/.test(name))active();
  const doc=parseXml(raw);documents.set(name,doc);
  if(/^xl\/(?:workbook|styles|sharedStrings)\.xml$|^xl\/worksheets\//.test(name)){const verify=(node:XmlNode)=>{if(node.namespaceURI!==main||node.attrs['xmlns:r']!==undefined&&node.attrs['xmlns:r']!==officeRel)active();for(const child of node.children)verify(child);};verify(doc);}
  for(const rel of descendants(doc,'Relationship')){const target=rel.attrs['Target']??'';if(rel.attrs['TargetMode']==='External'||!target||/^(?:[a-z]+:|\\)|(?:^|\/)\.\.(?:\/|$)/i.test(target)||target.startsWith('/')&&!/^\/(?:xl|docProps)\/[A-Za-z0-9_./-]+$/.test(target))active();}
  for(const name of ['f','externalReference','definedName','hyperlink','oleObject','connection','control','extLst','macroSheet','legacyDrawing','drawing'])if(descendants(doc,name).length)active();
  for(const n of descendants(doc,'formula1'))if(!/^"[A-Z0-9_,.-]+"$/.test(n.text))active();if(descendants(doc,'formula2').length)active();
 }
 const allCells=[...documents].filter(([name])=>/^xl\/worksheets\//.test(name)).flatMap(([,doc])=>descendants(doc,'c'));cells=allCells.length;if(cells>50000)throw new AppError(413,'FILE_LIMIT_EXCEEDED');for(const c of allCells)address(c.attrs['r']??'');
 const content=documents.get('[Content_Types].xml'),book=documents.get('xl/workbook.xml'),rels=documents.get('xl/_rels/workbook.xml.rels'),rootRels=documents.get('_rels/.rels');
 if(!content||!book||!rels||!rootRels||localName(book)!=='workbook'||rootNamespace(book)!==main)active();
 if(localName(content!)!=='Types'||content!.namespaceURI!==contentNS||[rels!,rootRels!].some(r=>localName(r)!=='Relationships'||r.namespaceURI!==packageRel||r.children.some(c=>localName(c)!=='Relationship'||c.namespaceURI!==packageRel)))active();
 const types=new Set(['application/vnd.openxmlformats-package.relationships+xml','application/xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml','application/vnd.openxmlformats-officedocument.theme+xml','application/vnd.openxmlformats-package.core-properties+xml','application/vnd.openxmlformats-officedocument.extended-properties+xml']);
 const defaults=new Map<string,string>(),overrides=new Map<string,string>();
 for(const node of content!.children){const type=node.attrs['ContentType']??'';if(node.namespaceURI!==contentNS||!types.has(type))active();if(localName(node)==='Default'){const ext=node.attrs['Extension']??'';if(!['xml','rels'].includes(ext)||defaults.has(ext))active();defaults.set(ext,type);}else if(localName(node)==='Override'){const part=node.attrs['PartName']??'';if(!part.startsWith('/')||!parts.has(part.slice(1))||overrides.has(part))active();overrides.set(part,type);}else active();}
 for(const name of parts.keys()){if(name==='[Content_Types].xml')continue;const type=overrides.get('/'+name)??defaults.get(name.split('.').at(-1)!);if(!type||name.endsWith('.rels')&&type!=='application/vnd.openxmlformats-package.relationships+xml'||/^xl\/worksheets\//.test(name)&&type!=='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'||name==='xl/workbook.xml'&&type!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')active();}
 const rootIds=new Set<string>();let officeDocuments=0;
 for(const rel of children(rootRels!,'Relationship')){const id=rel.attrs['Id']??'',type=rel.attrs['Type'],target=(rel.attrs['Target']??'').replace(/^\//,'');if(rootIds.has(id)||!id||!parts.has(target)||rel.attrs['TargetMode']&&rel.attrs['TargetMode']!=='Internal')active();rootIds.add(id);if(type===officeRel+'/officeDocument'){if(target!=='xl/workbook.xml')active();officeDocuments++;}else if(type==='http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'){if(target!=='docProps/core.xml')active();}else if(type===officeRel+'/extended-properties'){if(target!=='docProps/app.xml')active();}else active();}if(officeDocuments!==1)active();
 const relationships=new Map<string,string>(),targets=new Set<string>();for(const rel of children(rels!,'Relationship')){const id=rel.attrs['Id']!,target=rel.attrs['Target']!.replace(/^\//,''),type=rel.attrs['Type']??'';if(relationships.has(id)||!id||targets.has(target)||rel.attrs['TargetMode']&&rel.attrs['TargetMode']!=='Internal')active();targets.add(target);const resolved=target.startsWith('xl/')?target:'xl/'+target;if(!parts.has(resolved)||!['worksheet','styles','theme','sharedStrings'].some(k=>type===officeRel+'/'+k)||type===officeRel+'/worksheet'&&!/^xl\/worksheets\/sheet[0-9]+\.xml$/.test(resolved))active();relationships.set(id,resolved);}
 const shared=documents.get('xl/sharedStrings.xml'),strings=shared?children(shared,'si').map(n=>text(n)):[];
 if(strings.some(v=>v.length>32767)||strings.length>50000)throw new AppError(413,'FILE_LIMIT_EXCEEDED');
 const sheets=child(book!,'sheets');if(!sheets||sheets.children.length>13)throw new AppError(413,'FILE_LIMIT_EXCEEDED');const seen=new Set<string>(),usedSheets=new Set<string>();
 for(const sheet of children(sheets,'sheet')){
  const name=sheet.attrs['name']??'',spec=dict.sheets.find(s=>s.name===name);if(seen.has(name))active();seen.add(name);
  if(sheet.attrs['state']&&sheet.attrs['state']!=='visible')active();
  const filename=relationships.get(sheet.attrs['r:id']??''),doc=filename?documents.get(filename):undefined;if(!doc||localName(doc)!=='worksheet'||rootNamespace(doc)!==main)active();
  if(!filename||usedSheets.has(filename))active();usedSheets.add(filename!);
  if(!spec){const unknown=new Set(descendants(doc!,'c').filter(c=>address(c.attrs['r']??'').row>1&&(child(c,'v')?.text||text(c))).map(c=>address(c.attrs['r']??'').row));rows+=unknown.size;if(rows>1000)throw new AppError(413,'FILE_LIMIT_EXCEEDED');issues.push({sheet:'Control',row:1,cell:'A1',code:'UNKNOWN_SHEET',severity:'ERROR',expectedType:'TEXT',relatedKeys:[]});continue;}
  const byRow=new Map<number,Map<number,{value:unknown;type:string}>>();
  for(const c of descendants(doc!,'c')){
   const a=address(c.attrs['r']??''),t=c.attrs['t']??'n';if(!['n','s','str','inlineStr','b'].includes(t))active();
   let value:unknown;const raw=child(c,'v')?.text??'';
   if(t==='s'){if(!/^(0|[1-9][0-9]*)$/.test(raw)||Number(raw)>=strings.length)active();value=strings[Number(raw)]!;}
   else if(t==='inlineStr')value=text(c);else if(t==='str')value=raw;else if(t==='b')value=raw==='1';else value=raw===''?'':Number(raw);
   if(typeof value==='string'&&value.length>32767)throw new AppError(413,'FILE_LIMIT_EXCEEDED');
   if(!byRow.has(a.row))byRow.set(a.row,new Map());if(byRow.get(a.row)!.has(a.col))active();byRow.get(a.row)!.set(a.col,{value,type:t});
  }
  const header=byRow.get(1);for(let i=0;i<spec.columns.length;i++)if(header?.get(i+1)?.value!==spec.columns[i]!.name)issues.push({sheet:name,row:1,cell:columnName(i+1)+'1',code:'UNKNOWN_COLUMN',severity:'ERROR',expectedType:'TEXT',relatedKeys:[]});
  if(header&&header.size>spec.columns.length)issues.push({sheet:name,row:1,cell:columnName(spec.columns.length+1)+'1',code:'UNKNOWN_COLUMN',severity:'ERROR',expectedType:'TEXT',relatedKeys:[]});
  for(const[r,values]of [...byRow].sort(([a],[b])=>a-b)){
   if(r===1||[...values.values()].every(c=>c.value===''))continue;if(name!=='Control'&&++rows>1000)throw new AppError(413,'FILE_LIMIT_EXCEEDED');const row:Data={};
   for(let i=0;i<spec.columns.length;i++){
    const def=spec.columns[i]!,cell=values.get(i+1);if(!cell||cell.value===''){if(def.required)issues.push({sheet:name,row:r,cell:columnName(i+1)+r,code:'REQUIRED',severity:'ERROR',expectedType:def.type,relatedKeys:[]});continue;}
    let value=cell.value;if(value==='\\N'&&def.nullable)value=null;
    if(def.type==='INTEGER'){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)issues.push({sheet:name,row:r,cell:columnName(i+1)+r,code:'TYPE_INVALID',severity:'ERROR',expectedType:'INTEGER',relatedKeys:[]});}
    else if(value!==null&&typeof value!=='string')issues.push({sheet:name,row:r,cell:columnName(i+1)+r,code:'TYPE_INVALID',severity:'ERROR',expectedType:def.type,relatedKeys:[]});
    row[def.name]=value;
   }
   data[name]!.push(row);
  }
 }
 for(const sheet of dict.sheets)if(!seen.has(sheet.name))issues.push({sheet:sheet.name,row:1,cell:'A1',code:'UNKNOWN_SHEET',severity:'ERROR',expectedType:'TEXT',relatedKeys:[]});
 if([...parts.keys()].filter(p=>/^xl\/worksheets\//.test(p)).some(p=>!usedSheets.has(p)))active();
 if(!exchangeContract().valid('Workbook',data)&&!issues.length)issues.push({sheet:'Control',row:1,cell:'A1',code:'TYPE_INVALID',severity:'ERROR',expectedType:'TEXT',relatedKeys:[]});
 if(performance.now()-started>10000)throw new AppError(503,'FILE_BUDGET_EXCEEDED');return{data,issues,rows,cells,expandedBytes:[...parts.values()].reduce((n,b)=>n+b.length,0)};
}
