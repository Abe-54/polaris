"""Capture immutable legal roots for embedded Rust compilers and disclosed PHAR candidates."""
import argparse
import hashlib
import json
import pathlib
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
linkage = json.loads((args.output / 'native-linkage.json').read_text())
commits = sorted({commit for row in linkage for commit in row.get('rustcSourceCommits', [])})
records = {commit: legal.source_record('https://codeload.github.com/rust-lang/rust/tar.gz/' + commit,
                                       cache, args.output) for commit in commits}
(args.output / 'rust-runtime-sources.json').write_text(json.dumps(records, indent=2) + '\n')
box = []
for name, repository, commit in [('box-requirement-checker', 'humbug/box', '4.4.0'),
                                  ('composer/semver', 'composer/semver', '35e8d0af4486141bc745f23a29cc2091eb624a32')]:
    box.append({'name': name, 'source': legal.source_record(
        'https://codeload.github.com/' + repository + '/tar.gz/' + commit, cache, args.output)})
release_url = 'https://github.com/box-project/box/releases/download/4.5.0/box.phar'
release_sha = 'afb834f00239d65b2327face19aa0cd3101b91add0d3768eae542d7c6f50328e'
release = legal.download(release_url, cache)
if hashlib.sha256(release).hexdigest() != release_sha:
    raise ValueError('Box release integrity')
box.append({'name': 'box-release-build-input', 'releaseUrl': release_url, 'releaseSha256': release_sha,
            'source': legal.source_record('https://codeload.github.com/box-project/box/tar.gz/4.5.0', cache, args.output)})
(args.output / 'php-box-sources.json').write_text(json.dumps(box, indent=2) + '\n')
print('Legal candidates captured; PHAR checker provenance and static runtime closure remain unverified.')
