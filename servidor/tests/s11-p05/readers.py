# S11-P05 (Claude): independent readers for exported files. Standard library csv/zipfile/xml.etree + pypdf only;
# no Caudelyx code. Usage: python -I readers.py <csv> <xlsx> <pdf>  -> JSON on stdout.
import csv, io, json, re, sys, zipfile
import xml.etree.ElementTree as ET

DANGER = re.compile(r'^[\s\x00-\x1f\x7f\u0085   -‏ -  ⁠-⁯　﻿]*[=+\-@]')
def decode_text(v):
    """S11-TEXT-1 as documented in REPORTS_EXPORTS_S11: \\N is null, a leading quote protects =,+,-,@, quote and \\N."""
    if v == '\\N':
        return None
    if v.startswith("'"):
        o = v[1:]
        if o.startswith("'") or o.startswith('\\N') or DANGER.match(o):
            return o
        raise ValueError('non-reversible quote: ' + v[:40])
    return v

def read_csv(path):
    raw = open(path, 'rb').read()
    text = raw.decode('utf-8')
    rows = list(csv.reader(io.StringIO(text, newline='')))
    unsafe = [r[i] for r in rows for i in range(len(r)) if DANGER.match(r[i]) and not re.fullmatch(r'-?[0-9]+(\.[0-9]+)?', r[i])]
    return {'rows': rows, 'unprotectedDangerous': unsafe, 'bytes': len(raw)}

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def read_xlsx(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    formulas = [n for n in names if n.endswith('.xml') and re.search(rb'<(\w+:)?f[ >/]', z.read(n))]
    external = [n for n in names if n.endswith('.rels') and b'External' in z.read(n)]
    active = [n for n in names if re.search(r'vba|externalLink|activeX|embeddings|oleObject|connections', n, re.I)]
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    sheets = [s.get('name') for s in wb.find('m:sheets', NS)]
    out = {}
    for i, name in enumerate(sheets, 1):
        root = ET.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))
        rows = []
        for r in root.iter('{%s}row' % NS['m']):
            vals = []
            for c in r.findall('m:c', NS):
                t = c.get('t', 'n')
                if t == 'inlineStr':
                    vals.append(''.join(x.text or '' for x in c.iter('{%s}t' % NS['m'])))
                elif c.find('m:v', NS) is not None:
                    vals.append(int(c.find('m:v', NS).text) if t == 'n' else c.find('m:v', NS).text)
                else:
                    vals.append(None)
            rows.append(vals)
        out[name] = rows
    return {'sheets': out, 'formulaParts': formulas, 'externalRels': external, 'activeParts': active, 'parts': names}

ACTIVE = [b'/JavaScript', b'/JS', b'/URI', b'/Launch', b'/OpenAction', b'/AA', b'/EmbeddedFile', b'/SubmitForm', b'/GoToR', b'/XFA', b'/RichMedia', b'/ImportData', b'/F (file', b'http://', b'https://', b'file:']
def read_pdf(path):
    from pypdf import PdfReader
    raw = open(path, 'rb').read()
    # Object dictionaries only: compressed stream bytes are opaque and could match a token by chance.
    dicts = re.sub(rb'stream\r?\n.*?endstream', b'', raw, flags=re.S)
    reader = PdfReader(path)
    texts = [p.extract_text() or '' for p in reader.pages]
    root = reader.trailer['/Root']
    return {'pages': len(reader.pages), 'text': texts, 'activeTokens': [t.decode() for t in ACTIVE if t in dicts],
            'catalogKeys': sorted(str(k) for k in root.keys()), 'bytes': len(raw), 'header': raw[:8].decode('latin1')}

if __name__ == '__main__':
    c, x, p = sys.argv[1:4]
    print(json.dumps({'csv': read_csv(c), 'xlsx': read_xlsx(x), 'pdf': read_pdf(p)}, ensure_ascii=True))
