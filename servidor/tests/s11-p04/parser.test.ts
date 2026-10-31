/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex -- Synthetic tests use fixed fixture contracts, pinned workbook markup and registered own UUID filesystem roots; destructive leaves require owner/realpath checks. No HTTP-supplied paths or executable text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseWorkbook} from '../../src/modules/exchange/workbook.js';
import {readZip,writeZip,crc32} from '../../src/modules/exchange/zip.js';
import {parseXml} from '../../src/modules/exchange/xml.js';
import {workbookIdentity,jsonText} from '../../src/modules/exchange/canonical.js';
const file=(name:string)=>readFileSync('../../Construccion/Sprints/S11/Plantillas/v1.0.0/'+name+'.xlsx');
test('reads all frozen XLSX samples without executing any formulas; invalid data remains invalid',()=>{
 for(const name of ['caudelyx-import-template','opening-600','wealth-200m']){const parsed=parseWorkbook(file(name));assert.equal(parsed.issues.length,0,JSON.stringify(parsed.issues));assert.equal(Object.keys(parsed.data).length,13);}
 const p=parseWorkbook(file('negative-cases'));assert.ok(p.issues.length);assert.equal(parseWorkbook(file('opening-600')).data['Apertura']![0]!['amount'],'100.00');
});
test('semantic identity ignores physical ZIP packaging and sheet row ordering, includes namespace and scope',()=>{
 const bytes=file('opening-600'),p=parseWorkbook(bytes),repacked=writeZip(new Map([...readZip(bytes)].reverse()));assert.notDeepEqual(bytes,repacked);assert.equal(workbookIdentity(p.data,{book:'a'}),workbookIdentity(parseWorkbook(repacked).data,{book:'a'}));
 const copy=structuredClone(p.data);copy['Apertura']!.reverse();assert.equal(workbookIdentity(copy,{book:'a'}),workbookIdentity(p.data,{book:'a'}));assert.notEqual(workbookIdentity(copy,{book:'b'}),workbookIdentity(p.data,{book:'a'}));
});
test('rejects XML entity/DTD/prototype/unsafe ZIP/content before returning a financial value',()=>{
 for(const xml of ['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><x>&e;</x>','<x a="1" a="2"/>','<x>&unknown;</x>','<x><y></x>'])assert.throws(()=>parseXml(Buffer.from(xml)));
 for(const xml of ['<evil:x/>','<x xmlns:a="urn:same" xmlns:b="urn:same" a:k="1" b:k="2"/>','<x xmlns:xml="urn:other"/>','<x>&#xFFFF;</x>','<x>\x01</x>'])assert.throws(()=>parseXml(Buffer.from(xml)));
 assert.throws(()=>jsonText('{"__proto__":{"roles":["SA"]}}'));
 for(const value of ['{"a":1,"a":2}','{"a":{"b":1,"b":2}}','{"a":1,"\\u0061":2}','{"é":1,"e\\u0301":2}'])assert.throws(()=>jsonText(value));
 assert.deepEqual(jsonText('{"a":[{"b":1},{"b":2}],"text":"commas, braces{}"}'),{a:[{b:1},{b:2}],text:'commas, braces{}'});
 const base=readZip(file('opening-600'));
 for(const[name,content]of [['xl/vbaProject.bin','bad'],['../outside','bad'],['xl/externalLinks/link1.xml','<x/>']]){const map=new Map(base);map.set(name!,Buffer.from(content!));assert.throws(()=>parseWorkbook(writeZip(map)));}
 for(const code of ['<f>1+1</f><v>2</v>','<f t="shared" si="1"/><v>100</v>']){const map=new Map(base),name='xl/worksheets/sheet1.xml',xml=map.get(name)!.toString().replace(/<(?:[A-Za-z]+:)?sheetData>/,'$&<row r="99"><c r="A99">'+code+'</c></row>');assert.ok(xml.includes(code),'attack was inserted into namespaced sample');map.set(name,Buffer.from(xml));assert.throws(()=>parseWorkbook(writeZip(map)));}
});
test('OOXML relationships, content types, prefix bindings and worksheet ownership must be congruent',()=>{
 const base=readZip(file('opening-600'));
 for(const [part,find,replace]of [
  ['xl/_rels/workbook.xml.rels','/relationships/worksheet','/relationships/connection'],
  ['_rels/.rels','xl/workbook.xml','xl/worksheets/sheet1.xml'],
  ['[Content_Types].xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/xml'],
  ['xl/workbook.xml','http://schemas.openxmlformats.org/officeDocument/2006/relationships','urn:untrusted-rel']
 ]){const map=new Map(base),original=map.get(part!)!.toString(),changed=original.replace(find!,replace!);assert.notEqual(changed,original,part);map.set(part!,Buffer.from(changed));assert.throws(()=>parseWorkbook(writeZip(map)),part);}
 const unknown=new Map(base),book=unknown.get('xl/workbook.xml')!.toString();unknown.set('xl/workbook.xml',Buffer.from(book.replace('name="Control"','name="HojaDesconocida"')));assert.ok(parseWorkbook(writeZip(unknown)).issues.some(i=>i.code==='UNKNOWN_SHEET'));
});

test('ZIP CRC, size/expansion/upload bounds and XML depth fail closed',()=>{
 assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);const data=writeZip(new Map([['x',Buffer.from('hello')]])),bad=Buffer.from(data);bad[31]=bad[31]!^1;assert.throws(()=>readZip(bad));
 assert.throws(()=>readZip(writeZip(new Map([['x',Buffer.alloc(1000000,65)]]))));
 assert.throws(()=>readZip(Buffer.alloc(5242881)));assert.throws(()=>parseXml(Buffer.from('<x>'.repeat(45)+'</x>'.repeat(45))));
});
