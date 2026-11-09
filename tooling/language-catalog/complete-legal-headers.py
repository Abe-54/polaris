import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--output', default='tooling/language-catalog')
parser.add_argument('--phar')
parser.add_argument('--fixture')
args=parser.parse_args()
from pathlib import Path
private_root = Path(args.root).resolve()
temporary_root = Path('/tmp').resolve()
if not private_root.is_relative_to(temporary_root) or private_root == temporary_root:
    parser.error('Private temporary root required')
import pathlib,io,tarfile,zipfile,re,json,hashlib
import importlib.util
import sys


def load(name, path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

m=load('legal','tooling/language-catalog/complete-notices.py');o=pathlib.Path(args.output);c=pathlib.Path(args.root)/'legal-cache'
def header(stream):
 b=b'';block=False
 for _ in range(300):
  line=stream.readline(4096)
  if not line:break
  stripped=line.strip()
  if not stripped:continue
  if stripped.startswith(b'/*'):block=True
  if block or stripped.startswith((b'//',b'#',b'--')):
   b+=line
   if block and b'*/' in line:block=False;break
  else:break
 return b if re.search(br'copyright|license|licence|redistribution',b,re.I) else b''
def captures(record, scope=None):
 u=record['url'];p=c/hashlib.sha256(u.encode()).hexdigest();b=p.read_bytes();ns=[]
 if b[:2]==b'PK':
  with zipfile.ZipFile(p) as a:
   for name in a.namelist():
    if name.endswith(('.java','.rs','.h','.c','.lua','.php')):
     with a.open(name) as stream:content=header(stream)
     if content:ns.append(m.save_notice(name+'#legal-header',content,o))
 else:
  with tarfile.open(p) as a:
   for entry in a.getmembers():
    relative=entry.name.split('/',1)[-1]
    if entry.isfile() and (not scope or relative.startswith(scope.rstrip('/')+'/')) and entry.name.endswith(('.java','.rs','.h','.c','.lua','.php')):
     with a.extractfile(entry) as stream:content=header(stream)
     if content:ns.append(m.save_notice(entry.name+'#legal-header',content,o))
 record['legalHeaders']=list({x['sha256']:x for x in ns}.values());return record
for filename in ['jdt-source-closure.json','cargo-notice-sources.json','php-notice-sources.json']:
 p=o/filename;rs=json.loads(p.read_text())
 for r in rs:
  if r.get('source'):
   scope=None
   if r.get('sourceReference'):
    match=re.search(r'path="([^"]+)"',r['sourceReference']);scope=match[1].rstrip('/;') if match else None
   elif r.get('vcs'):
    scope=r['vcs'].get('path_in_vcs')
   if r['name'].startswith('ra-ap-rustc_'):scope='compiler/'+r['name'].removeprefix('ra-ap-')
   captures(r['source'],scope)
 p.write_text(json.dumps(rs,indent=2)+'\n');print(filename,'headers',sum(len(r.get('source',{}).get('legalHeaders',[])) for r in rs),flush=True)
