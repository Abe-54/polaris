"""Close exact compiler stdlib source-lock notices from embedded Rust source identities."""
import argparse
import hashlib
import io
import json
import pathlib
import tarfile
import tomllib
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
parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
temporary = pathlib.Path('/tmp').resolve()
if not args.root.resolve().is_relative_to(temporary) or args.root.resolve() == temporary:
    parser.error('Private temporary root required')
cache = args.root / 'legal-cache'
cache.mkdir(parents=True, exist_ok=True)
runtimes = json.loads((args.output / 'rust-runtime-sources.json').read_text())
results = []
for commit, source in runtimes.items():
    data = legal.download(source['url'], cache)
    if hashlib.sha256(data).hexdigest() != source['sha256']:
        raise ValueError('Compiler source archive integrity')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        member = next(m for m in archive.getmembers() if m.name.endswith('/library/Cargo.lock'))
        lock = archive.extractfile(member).read()
        packages = tomllib.loads(lock.decode())['package']
    entries = []
    for package in packages:
        if not package.get('source', '').startswith('registry+'):
            continue
        identity = package['name'] + '-' + package['version']
        url = 'https://static.crates.io/crates/' + package['name'] + '/' + identity + '.crate'
        crate = legal.download(url, cache)
        if hashlib.sha256(crate).hexdigest() != package['checksum']:
            raise ValueError('Stdlib dependency integrity: ' + identity)
        with tarfile.open(fileobj=io.BytesIO(crate), mode='r:gz') as archive:
            manifest = archive.extractfile(identity + '/Cargo.toml').read()
            metadata = tomllib.loads(manifest.decode())['package']
        entries.append({'name': package['name'], 'version': package['version'], 'url': url,
                        'integrity': 'sha256:' + package['checksum'], 'license': metadata.get('license'),
                        'manifest': legal.save_notice(identity + '/Cargo.toml#stdlib-source-grant', manifest, args.output),
                        'notices': legal.archive_notices(crate, args.output)})
    results.append({'rustSourceCommit': commit, 'sourceIntegrity': 'sha256:' + source['sha256'],
                    'sourceLock': legal.save_notice(member.name, lock, args.output), 'packages': entries,
                    'scope': 'Complete frozen stdlib source-lock inventory, not inferred binary link membership. Additional target libc/unwinder closure is separately required.'})
(args.output / 'rust-stdlib-closure.json').write_text(json.dumps(results, indent=2) + '\n')
print('Two exact compiler stdlib inventories captured; static target runtime verification remains separate.')
