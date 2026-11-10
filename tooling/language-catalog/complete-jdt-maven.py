"""Retain bounded exact nested Maven source/legal metadata without extracting code."""
import argparse
import hashlib
import io
import json
import pathlib
import urllib.request
import zipfile
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
parser.add_argument('--root', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
temporary = pathlib.Path('/tmp').resolve()
if not args.root.resolve().is_relative_to(temporary) or args.root.resolve() == temporary:
    parser.error('Private temporary root required')
source = pathlib.Path(__file__).resolve().parent
legal = load('legal', str(source / 'complete-notices.py'))
cache = args.root / 'maven-legal-cache'
cache.mkdir(parents=True, exist_ok=True)
(args.output / 'notices').mkdir(parents=True, exist_ok=True)
inventory = json.loads((source / 'jdt-nested-metadata.json').read_text())
records = []
budget = 64 * 1024 * 1024


def fetch(url):
    global budget
    path = cache / hashlib.sha256(url.encode()).hexdigest()
    if path.exists():
        data = path.read_bytes()
    else:
        request = urllib.request.Request(url, headers={'User-Agent': 'Polaris-legal-audit'})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(min(budget, 8 * 1024 * 1024) + 1)
        if len(data) > min(budget, 8 * 1024 * 1024):
            raise ValueError('Bounded download budget exceeded')
        path.write_bytes(data)
    budget -= len(data)
    if budget < 0:
        raise ValueError('Bounded total budget exceeded')
    return data


for row in inventory:
    for coordinate in row['coordinates']:
        group, artifact, version = (coordinate[k] for k in ('groupId', 'artifactId', 'version'))
        record = {'path': row['path'], 'nestedSha256': row['sha256'], 'coordinate': coordinate}
        base = ('https://repo.maven.apache.org/maven2/' + group.replace('.', '/') + '/' +
                artifact + '/' + version + '/' + artifact + '-' + version)
        try:
            pom_url = base + '.pom'
            pom = fetch(pom_url)
            record['pom'] = {'url': pom_url, **legal.save_notice('pom.xml', pom, args.output)}
            url = base + '-sources.jar'
            payload = fetch(url)
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                names = sorted(archive.namelist())
            record['source'] = {'url': url, 'sha256': hashlib.sha256(payload).hexdigest(),
                                'bytes': len(payload), 'fileNameInventorySha256':
                                hashlib.sha256('\n'.join(names).encode()).hexdigest(),
                                'notices': legal.archive_notices(payload, args.output)}
            record['scope'] = 'Exact embedded Maven identity and immutable source/legal archive; native/shaded build membership remains separately required.'
        except Exception as error:
            record['missingEvidence'] = [str(error)]
        records.append(record)
        print(group, artifact, version, 'missing' if 'missingEvidence' in record else 'captured', flush=True)
(args.output / 'jdt-nested-maven-sources.json').write_text(json.dumps(records, indent=2) + '\n')
print('Records', len(records), 'missing', sum('missingEvidence' in r for r in records), flush=True)
