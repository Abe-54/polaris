"""Capture Go binary build info and immutable module/toolchain legal closure."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
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


def escaped(module):
    return re.sub('[A-Z]', lambda m: '!' + m[0].lower(), module)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    temporary = pathlib.Path('/tmp').resolve()
    if not args.root.resolve().is_relative_to(temporary) or args.root.resolve() == temporary:
        parser.error('Private temporary root required')
    cache = args.root / 'legal-cache'
    cache.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((args.output / '../../apps/daemon/src/languages/catalog/catalog.json').read_text())
    tool = next(t for t in catalog['tools'] if t['id'] == 'shfmt')
    env = {'PATH': os.environ['PATH'], 'GOTOOLCHAIN': 'local', 'GOPATH': str(args.root / 'go'),
           'GOCACHE': str(args.root / 'go-cache'), 'GOENV': 'off'}
    builds = []
    modules = {}
    runtimes = set()
    for artifact in tool['artifacts']:
        data = legal.download(artifact['url'], cache)
        digest = hashlib.sha256(data).hexdigest()
        if 'sha256:' + digest != artifact['integrity']:
            raise ValueError('Artifact integrity')
        path = args.root / artifact['id']
        path.write_bytes(data)
        output = subprocess.check_output(['go', 'version', '-m', str(path)], env=env, text=True)
        output = output.replace(str(path), artifact['id'])
        builds.append({'artifactId': artifact['id'], 'integrity': artifact['integrity'], 'buildInfo': output})
        runtimes.add(output.splitlines()[0].rsplit(' ', 1)[1])
        for name, version in re.findall(r'^\s+(?:mod|dep)\s+(\S+)\s+(\S+)', output, re.M):
            identity = name + '@' + version
            if identity not in modules:
                url = 'https://proxy.golang.org/' + escaped(name) + '/@v/' + version + '.zip'
                modules[identity] = legal.source_record(url, cache, args.output)
    runtime_sources = {version: legal.source_record('https://go.dev/dl/' + version + '.src.tar.gz', cache, args.output)
                       for version in sorted(runtimes)}
    result = {'tool': 'shfmt', 'version': tool['version'], 'builds': builds,
              'modules': modules, 'toolchains': runtime_sources}
    (args.output / 'shfmt-build-closure.json').write_text(json.dumps(result, indent=2) + '\n')
    print('shfmt', len(builds), 'build infos', len(modules), 'source modules', len(runtime_sources), 'toolchains')


if __name__ == '__main__':
    main()
