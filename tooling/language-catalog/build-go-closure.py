"""Build gopls privately with an existing Go toolchain and attest its actual closure."""
import argparse
import hashlib
import io
import json
import os
import pathlib
import subprocess
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


legal = load('legal', str(pathlib.Path(__file__).with_name('complete-notices.py')))


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
    inventory = json.loads((args.output / 'gopls-modules.json').read_text())
    url = 'https://proxy.golang.org/golang.org/x/tools/gopls/@v/v0.23.0.zip'
    data = legal.download(url, cache)
    if hashlib.sha256(data).hexdigest() != inventory['sourceZipSha256']:
        raise ValueError('Root source integrity')
    source = args.root / 'gopls-source'
    source.mkdir(exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in archive.namelist():
            relative = pathlib.PurePosixPath(name)
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Source traversal')
        archive.extractall(source)
    work = source / 'golang.org/x/tools/gopls@v0.23.0'
    env = {'PATH': os.environ['PATH'], 'GOTOOLCHAIN': 'local', 'GOPATH': str(args.root / 'go'),
           'GOCACHE': str(args.root / 'go-cache'), 'GOMODCACHE': str(args.root / 'go-mod'),
           'GOENV': 'off', 'GOPROXY': 'https://proxy.golang.org', 'GOSUMDB': 'sum.golang.org',
           'CGO_ENABLED': '0', 'GOFLAGS': '-mod=readonly', 'GOTELEMETRY': 'off'}
    proc = subprocess.run(['go', 'mod', 'download', '-json'], cwd=work, env=env,
                          text=True, capture_output=True, timeout=300, check=True)
    decoder = json.JSONDecoder()
    text = proc.stdout
    modules = []
    while text.strip():
        item, end = decoder.raw_decode(text.lstrip())
        text = text.lstrip()[end:]
        expected = next((m for m in inventory['modules'] if m['path'] == item['Path'] and m['version'] == item['Version']), None)
        if not expected or hashlib.sha256(pathlib.Path(item['Zip']).read_bytes()).hexdigest() != expected['zipSha256']:
            raise ValueError('Unfrozen module: ' + item['Path'])
        modules.append({'path': item['Path'], 'version': item['Version'], 'sum': item['Sum'],
                        'goModSum': item['GoModSum'], 'zipSha256': expected['zipSha256']})
    if len(modules) != len(inventory['modules']):
        raise ValueError('Module closure size')
    binary = args.root / 'gopls'
    subprocess.run(['go', 'build', '-p=2', '-trimpath', '-o', str(binary), '.'], cwd=work, env=env,
                   timeout=300, check=True)
    build = subprocess.check_output(['go', 'version', '-m', str(binary)], env=env, text=True)
    version = build.splitlines()[0].rsplit(' ', 1)[1]
    runtime = legal.source_record('https://go.dev/dl/' + version + '.src.tar.gz', cache, args.output)
    root_source = legal.source_record(url, cache, args.output)
    result = {'tool': 'gopls', 'version': '0.23.0', 'artifactSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'buildInfo': build.replace(str(binary), 'gopls'), 'modules': modules,
              'source': root_source, 'toolchain': runtime, 'environmentKeys': sorted(env),
              'commands': ['go mod download -json', 'go build -p=2 -trimpath -o <private>/gopls .', 'go version -m <private>/gopls'],
              'limits': ['Darwin arm64 source-build only; no platform/capability certification.',
                         'Installer must enforce same local compiler identity and capture/review new actual closure for other compilers.']}
    (args.output / 'gopls-build-closure.json').write_text(json.dumps(result, indent=2) + '\n')
    print('gopls local-toolchain build:', version, len(modules), 'verified frozen modules', flush=True)


if __name__ == '__main__':
    main()
