"""Read Canvas lecture archives/notebooks as data only; never run their code."""
import html.parser
import io
import json
import pathlib
import subprocess
import sys
import zipfile

LIMIT = 120000
MAX_MEMBER = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024

class TextHTML(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.out, self.hidden = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        if not self.hidden:
            a = dict(attrs)
            if tag in ('p','div','br','li','h1','h2','h3','tr'):
                self.out.append('\n')
            if tag == 'img' and a.get('alt'):
                self.out.append('[Image: '+a['alt']+']')
    def handle_endtag(self, tag):
        if tag in ('script','style') and self.hidden:
            self.hidden -= 1
        elif not self.hidden and tag in ('p','div','li','h1','h2','h3','tr'):
            self.out.append('\n')
    def handle_data(self, data):
        if not self.hidden:
            self.out.append(data)

def extract(name, data):
    suffix = pathlib.PurePosixPath(name).suffix.lower()
    if suffix == '.pdf':
        result = subprocess.run(['pdftotext','-layout','-','-'], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=True)
        return result.stdout.decode('utf-8',errors='replace')[:LIMIT]
    if suffix == '.ipynb':
        nb = json.loads(data)
        out = []
        for cell in nb.get('cells', []):
            source = cell.get('source', [])
            if isinstance(source, list): source = ''.join(source)
            out.append(f"[{cell.get('cell_type','cell')}]\n{source}")
            for output in cell.get('outputs', []):
                text = output.get('text') or output.get('data', {}).get('text/plain')
                if text: out.append(''.join(text) if isinstance(text,list) else str(text))
        return '\n\n'.join(out)[:LIMIT]
    if suffix in ('.html','.htm'):
        parser = TextHTML()
        parser.feed(data.decode('utf-8',errors='replace'))
        return ''.join(parser.out)[:LIMIT]
    if suffix in ('.txt','.md','.py','.csv'):
        return data.decode('utf-8',errors='replace')[:LIMIT]
    return ''

def read_lecture(path):
    p = pathlib.Path(path)
    if p.suffix.lower() != '.zip':
        return extract(p.name, p.read_bytes())
    out, total = [], 0
    with zipfile.ZipFile(p) as archive:
        members = [m for m in archive.infolist() if not m.is_dir() and '__MACOSX' not in pathlib.PurePosixPath(m.filename).parts and not pathlib.PurePosixPath(m.filename).name.startswith('.')]
        if len(members) > 1000: raise ValueError('Archive contains too many members')
        out.append('Archive contents (binary images are not text-extracted):\n'+'\n'.join(m.filename for m in members))
        # Do not extract archive paths to disk. Only read recognized text resources.
        for m in members:
            if pathlib.PurePosixPath(m.filename).suffix.lower() not in ('.pdf','.ipynb','.html','.htm','.txt','.md','.py','.csv'): continue
            if m.file_size > MAX_MEMBER: raise ValueError('Archive member exceeds limit')
            total += m.file_size
            if total > MAX_TOTAL: raise ValueError('Archive exceeds uncompressed text-resource limit')
            out.append('\n--- '+m.filename+' ---\n'+extract(m.filename, archive.read(m)))
            if sum(map(len,out)) >= LIMIT:
                out.append('\n[Extraction text limit reached]')
                break
    return '\n'.join(out)[:LIMIT]

if __name__ == '__main__':
    print(read_lecture(sys.argv[1]))
