"""Map retained Lua bytes to pinned cached source archives; inspect only hashes/legal text."""
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
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
temporary = pathlib.Path('/tmp').resolve()
if not args.cache.resolve().is_relative_to(temporary) or args.cache.resolve() == temporary:
    parser.error('Private cached source root required')
root = pathlib.Path(__file__).resolve().parent
legal = load('legal', str(root / 'complete-notices.py'))
source = json.loads((root / 'native-source-closure.json').read_text())['lua-language-server']
sources = [("core", source)] + [(row['path'], row['source']) for row in source['submodules']
                              if not row['path'].startswith('meta/3rd/')]
hashes = {}
records = []
for component, record in sources:
    path = args.cache / hashlib.sha256(record['url'].encode()).hexdigest()
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != record['sha256']:
        raise ValueError('Pinned source archive integrity: ' + component)
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            content = archive.extractfile(member).read()
            digest = 'sha256:' + hashlib.sha256(content).hexdigest()
            hashes.setdefault(digest, []).append({'component': component, 'sourcePath': member.name,
                                                 'sourceSha256': record['sha256']})
    records.append({'component': component, 'source': record})
platforms = []
for manifest in sorted((root / 'packaging').glob('lua-*.json')):
    data = json.loads(manifest.read_text())
    files = [{'path': row['path'], 'integrity': row['integrity'],
              'sources': hashes.get(row['integrity'], [])} for row in data['files']]
    platforms.append({'manifest': manifest.name, 'postFilterIntegrity': data['postFilterIntegrity'],
                      'files': files, 'unmapped': [row['path'] for row in files if not row['sources']]})
result = {'scope': 'Exact matching retained file bytes only. Generated/native/runtime files require separate build provenance; no binary runtime closure is inferred.',
          'sources': records, 'platforms': platforms}
(args.output / 'lua-retained-source-map.json').write_text(json.dumps(result, indent=2) + '\n')
for platform in platforms:
    print(platform['manifest'], 'matched', len(platform['files']) - len(platform['unmapped']),
          'of', len(platform['files']), 'unmapped', platform['unmapped'])
