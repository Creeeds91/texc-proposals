"""
An independent opinion on whether a PDF carries JavaScript, for check.mjs attachments.

pypdf walks every object reachable from the trailer and reports any action
dictionary with /JS or /S /JavaScript, plus its page count. It is a different
parser from lib/pdf-inspect.js, so agreement between them means something.
Run with python3 -I. Prints {path: {"js": bool, "pages": int}} as JSON.
"""
import sys, json
from pypdf import PdfReader
from pypdf.generic import DictionaryObject, ArrayObject, IndirectObject, NameObject
out = {}
for path in sys.argv[1:]:
    r = PdfReader(path)
    seen = set(); stack = [r.trailer]; js = False; n = 0
    while stack and n < 200000:
        n += 1
        o = stack.pop()
        if isinstance(o, IndirectObject):
            k = (o.idnum, o.generation)
            if k in seen: continue
            seen.add(k)
            try: o = o.get_object()
            except Exception: continue
        if isinstance(o, DictionaryObject):
            if '/JS' in o or o.get('/S') == '/JavaScript': js = True
            stack.extend(o.values())
        elif isinstance(o, ArrayObject):
            stack.extend(o)
    out[path] = {'js': js, 'pages': len(r.pages)}
print(json.dumps(out))
