"""Independent, read-only PDF/CSV/XML oracle. No product formatter imported."""
import csv
import io
import json
import zipfile
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET
from pypdf import PdfReader

folder = Path('../../Construccion/Sprints/S12/Evidencias/S12-P04-FORMATS')
source = json.loads((folder / 'source.json').read_text(encoding='utf-8'))
reader = PdfReader(folder / 'corpus.pdf')
text = '\n'.join(page.extract_text() for page in reader.pages)
for expected in ['María', r'\u{674E}', r'\u{0001}', r'\u{202E}', r'\\u{674E}', '700.07']:
    assert expected in text, repr(expected)
assert '\x01' not in text and '\u202e' not in text
csv_rows = list(csv.reader(io.StringIO((folder / 'corpus.csv').read_text(encoding='utf-8-sig'))))
flat = [cell for row in csv_rows for cell in row]
for name in source['names']:
    assert name in flat or "'" + name in flat, repr(name)
assert sum(Decimal(v) for row in csv_rows for v in row if v == '100.01') == Decimal('700.07')
ns = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(folder / 'corpus.xlsx') as archive:
    xml = archive.read('xl/worksheets/sheet1.xml')
    root = ET.fromstring(xml)
    assert not root.findall('.//x:f', ns)
    xml_text = xml.decode('utf-8')
    assert '_x0001_' in xml_text and '\x01' not in xml_text
    amounts = [Decimal(v.text) for v in root.findall('.//x:t', ns) if v.text == '100.01']
    assert sum(amounts) == Decimal('700.07')
assert source['representation']['policy'] == 'PDF_ESCAPED_UNICODE_V1'
assert source['representation']['escapedScalarCount'] == 4  # Includes protected literal backslash.
print(json.dumps({'state': 'PASS', 'oracle': 'pypdf/csv/ElementTree/Decimal', 'pages': len(reader.pages), 'rows': 7, 'principalTotal': '700.07', 'pdfVisibleEscapes': 4, 'formulaNodes': 0}))
