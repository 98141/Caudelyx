import test from 'node:test';
import assert from 'node:assert/strict';
import {readZip,writeZip} from '../../src/modules/exchange/zip.js';
import {parseWorkbook} from '../../src/modules/exchange/workbook.js';
import {exportReport,pdfRepresentation,xstring} from '../../src/modules/exchange/formats.js';
import {reportRows,reportTotals} from '../../src/modules/exchange/reports.js';
import type {SnapshotData} from '../../src/modules/exchange/models.js';
import {workbook,uid} from './oracle.js';
import {normalizeWorkbook} from '../../src/modules/exchange/normalizer.js';
import {previewExternalKeys} from '../../src/modules/exchange/domains.js';
import type {ExchangeRepository} from '../../src/modules/exchange/repository.js';
import type {ClientSession} from 'mongodb';
import {isolated} from '../../src/modules/exchange/process.js';
import {join} from 'node:path';
const {writeOwn,projectRoot}=await import(new URL('../../../scripts/s12-p04-guard.mjs',import.meta.url).href) as typeof import('../../scripts/s12-p04-guard.mjs');
function sample(text:string):SnapshotData{const cut={asOf:'2026-10-31',recordedThrough:'2026-10-31T17:00:00Z',from:'2026-10-01',to:'2026-10-31'},rows=reportRows('PORTFOLIO',[{id:uid(90),loanId:uid(90),borrowerId:uid(91),borrowerCode:'SYNTHETIC',borrowerName:text,principal:'100.01',overduePrincipal:'0.00',overdueInterest:'0.00'}],cut);return{reportKind:'PORTFOLIO',meta:{cut,coverage:{status:'COMPLETE'},currency:'COP',scope:'BUSINESS'},rows,totalRows:rows.length,totals:reportTotals('PORTFOLIO',rows),sourceDigest:'a'.repeat(64),binding:'synthetic'};}
test('AFTER H02: valid borrower glyph/control exports PDF with explicit representation and exact original CSV',()=>{
 for(const text of ['Prestatario 李 S12','control\u0001S12']){const report=sample(text);assert.ok(exportReport('CSV',report).length>0);assert.equal(exportReport('PDF',report).subarray(0,5).toString(),'%PDF-');assert.equal(pdfRepresentation(report).escapedScalarCount,1);assert.ok(exportReport('CSV',report).toString('utf8').includes(text));}
});
test('AFTER H03: nonempty out-of-header cell produces its exact physical ERROR location',()=>{
 const parts=readZip(workbook('OPERATIVE','S12_H03',{Cuentas:[{externalKey:'ONE',action:'CREATE',code:'SYN_ACCOUNT',name:'Cuenta sintética',accountClass:'ASSET',kind:'BANK',currency:'COP'}]}));
 const name='xl/worksheets/sheet5.xml';assert.ok(parts.has(name));const xml=parts.get(name)!.toString('utf8');assert.ok(xml.includes('<x:row r="2">'));parts.set(name,Buffer.from(xml.replace('</x:sheetData>','<x:row r="3"><x:c r="J3" t="inlineStr"><x:is><x:t>dato no ignorar</x:t></x:is></x:c></x:row></x:sheetData>')));
 const parsed=parseWorkbook(writeZip(parts));assert.ok(parsed.issues.some(i=>i.cell==='J3'&&i.code==='EXTRA_HEADER_CELL'&&i.severity==='ERROR'&&i.expectedType==='EMPTY'));assert.deepEqual(parsed.rowNumbers?.['Cuentas'],[2,3]);
});

test('OOXML controls and literal escape-looking strings remain distinct and no malformed XML control is emitted',()=>{assert.equal(xstring(String.fromCharCode(1)),'_x0001_');assert.equal(xstring('_x0001_'),'_x005F_x0001_');assert.equal(xstring('a'+String.fromCharCode(13)+'b'),'a_x000D_b');});
test('H03 extra J2 preserves zero, false and whitespace as nonempty; empty cell is allowed; parser limits/formulas stay closed',()=>{
 const original=workbook('OPERATIVE','S12_H03_MORE',{Cuentas:[{externalKey:'ONE',action:'CREATE',code:'SYN_ACCOUNT',name:'Cuenta',accountClass:'ASSET',kind:'BANK',currency:'COP'}]});
 const mutate=(cell:string)=>{const parts=readZip(original),n='xl/worksheets/sheet5.xml';parts.set(n,Buffer.from(parts.get(n)!.toString().replace('</x:row></x:sheetData>',cell+'</x:row></x:sheetData>')));return writeZip(parts);};
 for(const cell of ['<x:c r="J2"><x:v>0</x:v></x:c>','<x:c r="J2" t="b"><x:v>0</x:v></x:c>','<x:c r="J2" t="inlineStr"><x:is><x:t xml:space="preserve"> </x:t></x:is></x:c>'])assert.ok(parseWorkbook(mutate(cell)).issues.some(i=>i.cell==='J2'&&i.code==='EXTRA_HEADER_CELL'));
 assert.ok(!parseWorkbook(mutate('<x:c r="J2"/>')).issues.some(i=>i.code==='EXTRA_HEADER_CELL'));
 for(const cell of ['<x:c r="AG2"><x:v>0</x:v></x:c>','<x:c r="J1002"><x:v>0</x:v></x:c>','<x:c r="J2"><x:f>1+1</x:f><x:v>2</x:v></x:c>'])assert.throws(()=>parseWorkbook(mutate(cell)));
 assert.throws(()=>exportReport('PDF',sample('\uD800')));
});
test('H04 generic Operaciones commands are checked against existing namespace/type/key before confirmation',async()=>{
 const scope={kind:'BUSINESS' as const,bookId:uid(2),ownerId:uid(3),organizationId:uid(2)},plan=normalizeWorkbook(parseWorkbook(workbook('OPERATIVE','S12_H04_COMMAND',{Operaciones:[{externalKey:'FUND_ONE',operationId:'businessCreateFund',commandJson:'{"mode":"VIRTUAL","label":"Reserva","purpose":"ASSET_PURCHASE","backingAccountId":"'+uid(4)+'","supportReference":"SYN"}'}]})),scope,{mode:'OPERATIVE',namespace:'S12_H04_COMMAND'});
 assert.equal(plan.commands.length,1);const repo={all:async()=>[{identityKey:scope.bookId+':S12_H04_COMMAND:FUND:FUND_ONE'}]} as unknown as ExchangeRepository;
 await previewExternalKeys(scope,plan,{} as ClientSession,repo);assert.ok(plan.issues.some(i=>i.code==='EXTERNAL_KEY_CONFLICT'&&i.sheet==='Operaciones'&&i.cell==='A2'));
});
test('affected format worker benchmark1000 Unicode/control rows stays within original S11 budgets',{timeout:180000},async()=>{
 const s=sample('María 李 control\u0001 =1+1');s.rows=Array.from({length:1000},(_,i)=>({...structuredClone(s.rows[0]!),id:uid(i+100)}));s.totalRows=1000;s.totals=reportTotals('PORTFOLIO',s.rows);const rows=[];
 for(const format of ['CSV','XLSX','PDF']){let checks=0;const start=performance.now(),r=await isolated<Buffer>({kind:'EXPORT',format,snapshot:s},async()=>{checks++;});assert.ok(r.value.length>0);assert.ok(r.value.length<=33554432);assert.ok(r.metrics.peakRSS<=536870912);assert.ok(r.metrics.durationMs<=60000);assert.ok(checks>=2);rows.push({format,rows:1000,outputBytes:r.value.length,...r.metrics,parentDurationMs:performance.now()-start,checks});}
 await writeOwn(join(projectRoot,'Construccion/Sprints/S12/Evidencias/S12-P04-FORMAT-CAPACITY.json'),JSON.stringify({state:'PASS',measurements:rows,memoryMeasurement:'Existing S11 worker checkpoints; includes generator allocation, not a hard OS RSS quota.'},null,2)+'\n');
});
