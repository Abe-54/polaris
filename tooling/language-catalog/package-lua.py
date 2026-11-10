"""Reproduce lua-core-v1 from immutable downloads; never approve or activate artifacts."""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
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


legal = load('legal', str(pathlib.Path(__file__).with_name('complete-notices.py')))


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def filtered_files(data, stage=None):
    files = []
    paths = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            path = member.name.rstrip('/')
            if not path or path.startswith(('/', './')) or '\\' in path or '\0' in path or '..' in path.split('/'):
                raise ValueError('Unsafe archive path: ' + path)
            if member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
                raise ValueError('Unsupported archive entry: ' + path)
            if path in paths:
                raise ValueError('Duplicate archive path: ' + path)
            paths.add(path)
            if member.isdir() or path == 'meta/3rd' or path.startswith('meta/3rd/'):
                continue
            content = archive.extractfile(member).read()
            files.append({'path': path, 'integrity': digest(content), 'size': len(content), 'mode': member.mode})
            if stage:
                target = stage / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(member.mode)
    return sorted(files, key=lambda row: row['path'].encode('utf8'))


def file_root(files):
    return digest(json.dumps(files, separators=(',', ':'), ensure_ascii=False).encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=pathlib.Path)
    parser.add_argument('--fixture', type=pathlib.Path)
    parser.add_argument('--stage-artifact')
    parser.add_argument('--output', default=pathlib.Path(__file__).resolve().parent, type=pathlib.Path)
    args = parser.parse_args()
    temporary = pathlib.Path('/tmp').resolve()
    root = args.root.resolve()
    if not root.is_relative_to(temporary) or root == temporary:
        parser.error('Private temporary root required')
    output = args.output
    catalog_path = (output / '../../apps/daemon/src/languages/catalog/catalog.json').resolve()
    catalog = json.loads(catalog_path.read_text())
    tool = next(row for row in catalog['tools'] if row['id'] == 'lua-language-server')
    cache = root / 'legal-cache'
    cache.mkdir(parents=True, exist_ok=True)
    manifests = output / 'packaging'
    manifests.mkdir(exist_ok=True)
    for artifact in tool['artifacts']:
        existing = args.fixture / 'assets' / artifact['id'] if args.fixture else None
        data = existing.read_bytes() if existing and existing.is_file() else legal.download(artifact['url'], cache)
        if digest(data) != artifact['integrity']:
            raise ValueError('Original download integrity: ' + artifact['id'])
        stage = root / 'filtered' / artifact['id'] if args.stage_artifact == artifact['id'] else None
        if stage:
            stage.mkdir(parents=True, exist_ok=False)
        files = filtered_files(data, stage)
        if not any(row['path'].startswith('meta/template/') for row in files) or not any(row['path'] == 'LICENSE' for row in files):
            raise ValueError('Core template or legal notice omitted')
        post = file_root(files)
        manifest = {'filter': 'lua-core-v1', 'sourceIntegrity': artifact['integrity'], 'postFilterIntegrity': post, 'files': files}
        path = manifests / (artifact['id'] + '.json')
        path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
        subprocess.run([str(output / '../../node_modules/.bin/oxfmt'), str(path)], check=True)
        artifact['packaging'] = {'filter': 'lua-core-v1', 'sourceIntegrity': artifact['integrity'],
                                 'manifest': 'packaging/' + path.name, 'manifestIntegrity': digest(path.read_bytes()),
                                 'postFilterIntegrity': post, 'disableThirdPartyDiscovery': True}
        print(artifact['id'], len(files), post, flush=True)
    catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
    subprocess.run([str(output / '../../node_modules/.bin/oxfmt'), str(catalog_path)], check=True)


if __name__ == '__main__':
    main()
