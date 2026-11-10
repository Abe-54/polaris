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
import json,pathlib,hashlib
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
s=json.loads((o/'notice-supplements.json').read_text());records=[]
for name,repo,ref,p in [('@vscode/l10n@0.0.18','microsoft/vscode-l10n','fc7e3d79ddb91a2cc24a9730aad912026a43dbf2','LICENSE'),('boolbase@1.0.0','fb55/boolbase','be0bcd8a4e917a0a5895e95b523fbbed05a64871','LICENSE')]:
 u='https://raw.githubusercontent.com/'+repo+'/'+ref+'/'+p;b=m.download(u,c);print(name,b.decode()[:200]);n=m.save_notice('upstream/'+p,b,o)
 s[name]=dict(n,source=u,sourceRef=ref)
 records.append(dict(identity=name,source=u,sourceRef=ref,notice=n))
 if name.startswith('boolbase'):
  u2='https://raw.githubusercontent.com/'+repo+'/'+ref+'/package.json';b2=m.download(u2,c);meta=json.loads(b2);assert meta['version']=='1.0.0' and meta['license']=='ISC';records[-1]['metadataSource']=u2;records[-1]['metadataSha256']=hashlib.sha256(b2).hexdigest();records[-1]['basis']='Exact version1.0.0 manifest and upstream ISC copyright notice; supplement adds no implementation.'
u='https://raw.githubusercontent.com/tabatkins/railroad-diagrams/c20d5f11a1350e0b0e5818937e5b1c419adc8d94/README.md';b=m.download(u,c);section=b[b.index(b'License\n-------'):];n=m.save_notice('upstream/CC0-declaration',section,o);cc=json.loads((o/'cc0-legal-source.json').read_text())
s['railroad-diagrams@1.0.0']=dict(n,source=u,sourceRef='c20d5f11a1350e0b0e5818937e5b1c419adc8d94',fullLegal=cc)
records.append(dict(identity='railroad-diagrams@1.0.0',source=u,sourceRef='c20d5f11a1350e0b0e5818937e5b1c419adc8d94',notice=n,fullLegal=cc))
for f in (o/'bundles').glob('*.json'):
 if f.stem=='sql-language-server':continue
 d=json.loads(f.read_text())
 for pkg in d['packages']:
  key=pkg['name']+'@'+pkg['version']
  if key in [x['identity'] for x in records]:
   r=s[key];pkg['notices']=[dict(path=r['path'],sha256=r['sha256'])]
   if 'fullLegal' in r:pkg['notices'].append(r['fullLegal']['notice'])
 f.write_text(json.dumps(d,indent=2)+'\n')
(o/'notice-supplements.json').write_text(json.dumps(s,indent=2)+'\n');(o/'npm-notice-sources.json').write_text(json.dumps(records,indent=2)+'\n')
