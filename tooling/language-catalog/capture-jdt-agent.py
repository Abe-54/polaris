"""Capture the snapshot Java agent's exact source/build recipe and shaded ASM legal root."""
import argparse
import hashlib
import json
import pathlib
import tarfile
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


parser = argparse.ArgumentParser()
parser.add_argument('--cache', required=True, type=pathlib.Path)
parser.add_argument('--root', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
temporary = pathlib.Path('/tmp').resolve()
for path in [args.cache, args.root]:
    if not path.resolve().is_relative_to(temporary) or path.resolve() == temporary:
        parser.error('Private temporary roots required')
source = pathlib.Path(__file__).resolve().parent
legal = load('legal', str(source / 'complete-notices.py'))
parent = next(row for row in json.loads((source / 'jdt-source-closure.json').read_text())
              if row['name'].startswith('org.eclipse.jdt.launching_'))
record = parent['source']
path = args.cache / hashlib.sha256(record['url'].encode()).hexdigest()
payload = path.read_bytes()
if hashlib.sha256(payload).hexdigest() != record['sha256']:
    raise ValueError('Exact parent source archive integrity')
metadata = []
with tarfile.open(path, 'r:gz') as archive:
    for member in archive.getmembers():
        if member.isfile() and '/org.eclipse.jdt.launching.javaagent/' in member.name and member.name.endswith(('pom.xml', 'MANIFEST.MF')):
            metadata.append(legal.save_notice(member.name, archive.extractfile(member).read(), args.output))
cache = args.root / 'legal-cache'
cache.mkdir(parents=True, exist_ok=True)
asm = legal.source_record('https://repo.maven.apache.org/maven2/org/ow2/asm/asm/9.10.1/asm-9.10.1-sources.jar', cache, args.output)
result = {'nestedPath': parent['name'] + '!/lib/javaagent-shaded.jar',
          'parentSha256': parent['sha256'], 'parentSourceReference': parent['sourceReference'],
          'source': record, 'buildMetadata': metadata,
          'coordinate': {'groupId': 'org.eclipse.jdt', 'artifactId': 'org.eclipse.jdt.launching.javaagent', 'version': '3.10.600-SNAPSHOT'},
          'shadedDependency': {'groupId': 'org.ow2.asm', 'artifactId': 'asm', 'version': '9.10.1', 'source': asm},
          'relocation': {'from': 'org.objectweb.asm', 'to': 'org.eclipse.jdt.launching.internal.org.objectweb.asm'},
          'plugins': {'compiler': '3.13.0', 'jar': '3.4.2', 'shade': '3.6.0'},
          'scope': 'Exact snapshot source identity and declared shade recipe/legal sources. Reproducible output, complete plugin closure and historical class/runtime membership remain unverified.'}
(args.output / 'jdt-agent-source-build.json').write_text(json.dumps(result, indent=2) + '\n')
print('Snapshot agent recipe captured; ASM 9.10.1 source/legal root', asm['sha256'])
