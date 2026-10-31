"""Independent readers only. Inputs/outputs are stdin/stdout, no filesystem writes."""
import sys,json,base64,io,csv,zipfile,xml.etree.ElementTree as ET,unicodedata
from pypdf import PdfReader

def escaped(v):
    significant=v
    while significant and (significant[0].isspace() or unicodedata.category(significant[0]) in ('Cc','Cf')):
        significant=significant[1:]
    return "'"+v if v.startswith(("'",'\\N')) or significant.startswith(('=','+','-','@')) else v

def value(c,xlsx=False):
    v=c['value']
    if v is None:return None if xlsx else '\\N'
    if xlsx and c['type']=='COUNT':return v
    text=('true' if v else 'false') if isinstance(v,bool) else str(v)
    return escaped(text) if c['type']=='TEXT' else text

checked=[]
for item in json.load(sys.stdin):
    raw=base64.b64decode(item['bytes'],validate=True);s=item['snapshot'];kind=item['format']
    if kind=='PDF':
        r=PdfReader(io.BytesIO(raw),strict=True)
        assert not any(k in r.trailer['/Root'] for k in ('/OpenAction','/AA','/AcroForm','/Names'))
        assert all(not p.get('/Annots') for p in r.pages)
        text='\n'.join(p.extract_text() for p in r.pages)
        assert 'Filas totales: '+str(s['totalRows']) in text
        assert 'Totales del conjunto' in text
        for row in s['rows']:
            assert row['id'] in text,(s['reportKind'],row['id'])
            for c in row['cells']:
                if c['value'] is not None:
                    expected=('true' if c['value'] else 'false') if isinstance(c['value'],bool) else str(c['value'])
                    assert expected in text,(s['reportKind'],expected)
        for c in s['totals']:
            if c['value'] is not None:assert str(c['value']) in text
    else:
        if kind=='CSV':
            matrix=list(csv.reader(io.StringIO(raw.decode('utf-8'),newline=''),strict=True));xlsx=False
            assert all(len(row)==len(matrix[0]) for row in matrix)
        else:
            z=zipfile.ZipFile(io.BytesIO(raw));xlsx=True
            assert len([n for n in z.namelist() if n.startswith('xl/worksheets/')])==4
            for n in z.namelist():
                text=z.read(n);assert b'<f>' not in text and b'TargetMode="External"' not in text and b'vba' not in text.lower()
            root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'));ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};matrix=[]
            for row in root.findall('x:sheetData/x:row',ns):
                cells=[]
                for c in row:
                    if c.get('t')=='inlineStr':cells.append(''.join(c.find('x:is',ns).itertext()))
                    elif c.get('t')=='n':cells.append(int(c.find('x:v',ns).text))
                    else:cells.append(None)
                matrix.append(cells)
        header=matrix[0];detail=[r for r in matrix[1:] if r[0]=='ROW'];totals=[r for r in matrix[1:] if r[0]=='TOTAL'];assert len(detail)==s['totalRows'];assert len(totals)==1
        for actual,row in zip(detail,s['rows']):
            assert actual[1]==row['id']
            for c in row['cells']:
                at=header.index(c['columnId']);assert actual[at]==value(c,xlsx),(s['reportKind'],c['columnId'],actual[at],value(c,xlsx));assert actual[at+1]==c['status'];assert actual[at+2]==c['reason']
        for c in s['totals']:
            at=header.index(c['columnId']);assert totals[0][at]==value(c,xlsx)
    checked.append({'reportKind':s['reportKind'],'format':kind,'rows':s['totalRows']})
print(json.dumps({'result':'PASS','checked':len(checked),'readers':['Python csv','zipfile + ElementTree','pypdf'], 'cases':checked}))
