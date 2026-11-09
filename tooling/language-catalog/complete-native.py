"""Capture release-matched source/legal/build provenance, including Lua gitlinks."""
import argparse
import concurrent.futures
import hashlib
import io
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


def resolve(repo, ref, cache):
    url = 'https://api.github.com/repos/' + repo + '/git/ref/tags/' + ref
    data = json.loads(legal.download(url, cache))
    obj = data['object']
    while obj['type'] == 'tag':
        obj = json.loads(legal.download(obj['url'], cache))['object']
    if obj['type'] != 'commit':
        raise ValueError('Not a commit')
    return obj['sha']


def capture(repo, commit, cache, output, recurse=False):
    url = 'https://codeload.github.com/' + repo + '/tar.gz/' + commit
    record = legal.source_record(url, cache, output)
    record.update(repository=repo, commit=commit)
    if not recurse:
        return record
    with tarfile.open(fileobj=io.BytesIO(legal.download(url, cache)), mode='r:gz') as archive:
        members = [m for m in archive.getmembers() if m.name.endswith('/.gitmodules')]
        if not members:
            return record
        text = archive.extractfile(members[0]).read().decode()
    tree_url = 'https://api.github.com/repos/' + repo + '/git/trees/' + commit + '?recursive=1'
    tree = json.loads(legal.download(tree_url, cache))
    gitlinks = {x['path']: x['sha'] for x in tree['tree'] if x['mode'] == '160000'}
    modules = []
    for block in re.split(r'\[submodule ', text)[1:]:
        path = re.search(r'path\s*=\s*(.*)', block)[1].strip()
        origin = re.search(r'url\s*=\s*(.*)', block)[1].strip()
        match = re.search(r'github.com[:/](.*?)(?:\.git)?$', origin)
        if path not in gitlinks or not match:
            modules.append({'path': path, 'origin': origin, 'missingEvidence': ['Unresolved gitlink']})
            continue
        try:
            modules.append(dict(path=path, source=capture(match[1], gitlinks[path], cache, output, True)))
        except Exception as error:
            modules.append({'path': path, 'origin': origin, 'commit': gitlinks[path],
                            'missingEvidence': [str(error)]})
    record['submodules'] = modules
    return record


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
    items = [('ruff', 'astral-sh/ruff', '0.16.10'),
             ('rust-analyzer', 'rust-lang/rust-analyzer', '2026-09-28'),
             ('lua-language-server', 'LuaLS/lua-language-server', '3.19.1'),
             ('phpactor', 'phpactor/phpactor', '2026.06.23.0'),
             ('shfmt', 'mvdan/sh', 'v3.14.1'),
             ('shellcheck', 'koalaman/shellcheck', 'v0.11.0')]
    def job(item):
        name, repo, tag = item
        commit = resolve(repo, tag, cache)
        return name, capture(repo, commit, cache, args.output, name == 'lua-language-server')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = dict(pool.map(job, items))
    (args.output / 'native-source-closure.json').write_text(json.dumps(records, indent=2) + '\n')
    print('Native source closures:', len(records))


if __name__ == '__main__':
    main()
