"""Retain embedded Lua license comments from exact pinned bee.lua source archives."""
import argparse
import hashlib
import json
import pathlib
import re
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
parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
temporary = pathlib.Path('/tmp').resolve()
if not args.root.resolve().is_relative_to(temporary) or args.root.resolve() == temporary:
    parser.error('Private temporary root required')
closure = json.loads((args.output / 'native-source-closure.json').read_text())['lua-language-server']
rows = []


def visit(source):
    if source.get('repository') == 'actboy168/bee.lua':
        cached = args.root / 'legal-cache' / hashlib.sha256(source['url'].encode()).hexdigest()
        content = legal.download(source['url'], cached.parent)
        assert hashlib.sha256(content).hexdigest() == source['sha256']
        with tarfile.open(cached) as archive:
            for entry in archive.getmembers():
                if entry.isfile() and entry.name.endswith(('/lua54/lua.h', '/lua55/lua.h')):
                    data = archive.extractfile(entry).read()
                    comments = [block for block in re.findall(br'/\*[\s\S]*?\*/', data)
                                if b'Permission is hereby granted' in block and b'Copyright' in block]
                    if len(comments) != 1:
                        raise ValueError('Expected full Lua permission/copyright comment')
                    rows.append({'source': source['url'], 'sourceIntegrity': 'sha256:' + source['sha256'],
                                 'commit': source['commit'], 'license': 'MIT',
                                 'notice': legal.save_notice(entry.name + '#legal-comment', comments[0], args.output)})
    for module in source.get('submodules', []):
        if 'source' in module:
            visit(module['source'])


visit(closure)
(args.output / 'lua-runtime-notices.json').write_text(json.dumps(rows, indent=2) + '\n')
print(len(rows), 'exact Lua runtime legal comments retained; static compiler runtime still unverified.')
