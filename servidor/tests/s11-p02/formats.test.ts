import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReport,encodeText,decodeText} from '../../src/modules/exchange/formats.js';
import {readZip} from '../../src/modules/exchange/zip.js';
import type {SnapshotData,ReportCell} from '../../src/modules/exchange/models.js';
const money=(columnId:string,value:string|null):ReportCell=>({columnId,type:'MONEY',unit:'COP',value,status:value===null?'UNAVAILABLE':'COMPLETE',reason:value===null?'MISSING_HISTORY':'NONE'});
test('reversible text escaping preserves original dangerous labels and legitimate signed exact money',()=>{
 for(const s of ['=1+1',' +SUM(A1)','\u00a0@evil','\u200b=1','\u0085+1',"'=x",'-calle','\\N','normal'])assert.equal(decodeText(encodeText(s)),s);
 assert.equal(encodeText('=1+1'),"'=1+1");
});
test('CSV/XLSX/PDF serialize exact values, totals and inactive text with local embedded Unicode font',()=>{
 const s:SnapshotData={reportKind:'PRINCIPAL',meta:{cut:{asOf:'2026-10-29',recordedThrough:'2026-10-29T12:00:00.000Z',from:'2026-10-01',to:'2026-10-29'},coverage:{status:'COMPLETE'}},rows:[{id:'synthetic',cells:[money('amount','9999999999999999.99'),{columnId:'metricId',type:'TEXT',unit:'NONE',value:'=file:///ningún-recurso',status:'COMPLETE',reason:'NONE'}],sourceRefs:[]}],totalRows:1,totals:[money('net','-50.00'),money('amount',null)],sourceDigest:'a',binding:'b'};
 const csv=exportReport('CSV',s).toString();assert.match(csv,/9999999999999999\.99/);assert.match(csv,/-50\.00/);assert.match(csv,/'=file/);assert.match(csv,/\\N/);
 const xlsx=readZip(exportReport('XLSX',s),{uploadBytes:33554432,expandedBytes:33554432,zipEntries:256,expansionRatio:100,timeMs:10000});for(const bytes of xlsx.values())assert.doesNotMatch(bytes.toString(),/<f\b|TargetMode="External"|vbaProject/);assert.match(xlsx.get('xl/worksheets/sheet1.xml')!.toString(),/9999999999999999\.99/);
 const pdf=exportReport('PDF',s);assert.equal(pdf.subarray(0,8).toString(),'%PDF-1.7');assert.doesNotMatch(pdf.toString('latin1'),/\/JavaScript|\/OpenAction|\/Launch|\/EmbeddedFile|\/AcroForm/);assert.match(pdf.toString('latin1'),/\/ToUnicode/);assert.match(pdf.toString('latin1'),/\/FontFile2/);
});
