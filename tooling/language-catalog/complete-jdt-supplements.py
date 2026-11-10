import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--output', default='tooling/language-catalog')
parser.add_argument('--phar')
parser.add_argument('--fixture', required=True)
args=parser.parse_args()
from pathlib import Path
private_root = Path(args.root).resolve()
temporary_root = Path('/tmp').resolve()
if not private_root.is_relative_to(temporary_root) or private_root == temporary_root:
    parser.error('Private temporary root required')
import pathlib,json,hashlib,re,zipfile
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

m=load('legal','tooling/language-catalog/complete-notices.py');o=pathlib.Path(args.output);c=pathlib.Path(args.root)/'legal-cache';rows=[]
for family,repo,ref,paths in [('flexmark','vsch/flexmark-java','f63c7959601288efcfe6328252490da72fd81283',['LICENSE.txt','LICENSE','LICENSE.md']),('hamcrest','hamcrest/JavaHamcrest','68984b85e869df6a888fffcad87e4b676a8fc0ac',['LICENSE']),('logback','qos-ch/logback','v_1.5.32',['LICENSE.txt','LICENSE','LICENSE.md','LICENSES'])]:
 for p in paths:
  u='https://raw.githubusercontent.com/'+repo+'/'+ref+'/'+p
  try:
   b=m.download(u,c);rows.append(dict(family=family,source=u,sourceRef=ref,notice=m.save_notice('upstream/'+p,b,o)));print(family,p,b[:100]);break
  except Exception as e:print(family,p,str(e))
# Retain metadata-only aggregator file names and hashes, no nonexistent sources required.
r=json.loads((o/'jdt-source-closure.json').read_text())
for x in r:
 if x['name']=='wrapped.com.vladsch.flexmark.flexmark-util_0.64.8.jar':
  with zipfile.ZipFile(str(Path(args.fixture)/'native/jdt/plugins'/x['name'])) as z:
   assert not any(n.endswith('.class') for n in z.namelist())
   x.pop('missingEvidence',None);x['metadataOnly']=[dict(path=n,sha256=hashlib.sha256(z.read(n)).hexdigest()) for n in z.namelist() if not n.endswith('/')]
   x['sourceRequirement']='No class/resource implementation; exact embedded manifest/POM retained by shipped JAR root.'
(o/'jdt-source-closure.json').write_text(json.dumps(r,indent=2)+'\n');(o/'jdt-notice-supplements.json').write_text(json.dumps(rows,indent=2)+'\n')
