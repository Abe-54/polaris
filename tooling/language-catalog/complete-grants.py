"""Retain immutable license declarations where upstream omits standalone legal files."""
import argparse
import hashlib
import io
import json
import pathlib
import tarfile
import tomllib
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



def enrich(records, inventory, php, args, cache):
    inspector = load('legal_search', str(pathlib.Path(__file__).with_name('legal-search.py')))
    catalog = json.loads((args.output / '../../apps/daemon/src/languages/catalog/catalog.json').read_text())
    inventories = {name: json.loads((args.output / (name + '-crates.json')).read_text())['packages']
                   for name in ('ruff', 'rust-analyzer')}
    for record in records:
        original = record['declaredLicense']
        if original not in ('MIT', 'MIT OR Apache-2.0', 'MIT/Apache-2.0'):
            raise ValueError('No reviewed license selection for ' + str(original))
        record['originalExpression'] = original
        record['selectedLicense'] = 'MIT'
        record['selectionBasis'] = 'Explicit package declaration selects MIT; historical slash alternatives are preserved verbatim, not applied as a universal override.'
        record['deliveryObligations'] = ['Retain the complete immutable manifest and available author metadata verbatim.',
                                         'Deliver separately discovered upstream legal comments/notices unchanged.',
                                         'Deliver pinned MIT standard terms labeled reference terms, not an upstream-authored file.',
                                         'Do not synthesize copyright holders or years. A1 review is required for this exact package/source scope.']
        record['archiveVerifiedAtExtraction'] = True
        record['standardTermsCommit'] = '31ba1a50e5397e00a304dbadc76531740e89ee48'
        identity = record['name'] + '-' + record['version']
        if record['ecosystem'] == 'cargo':
            package = next(p for p in inventory if p['name'] == record['name'] and p['version'] == record['version'])
            data = (args.fixture / 'crates' / (identity + '.crate')).read_bytes()
        else:
            package = next(p for p in php if p['name'] == record['name'] and p['version'] == record['version'])
            data = legal.download(package['source']['url'], cache)
        if 'sha256:' + hashlib.sha256(data).hexdigest() != record['archiveIntegrity']:
            raise ValueError('Archive changed before legal search')
        record['legalSearch'] = inspector.search(data, args.output)
        source = package.get('source')
        if source and isinstance(source, dict) and source.get('url') != record['archiveUrl']:
            upstream = legal.download(source['url'], cache)
            if hashlib.sha256(upstream).hexdigest() != source['sha256']:
                raise ValueError('Exact revision source archive integrity')
            record['revisionSearch'] = dict(inspector.search(upstream, args.output, package.get('vcs', {}).get('path_in_vcs')),
                                            url=source['url'], integrity='sha256:' + source['sha256'])
        scopes = []
        for tool in catalog['tools']:
            included = tool['id'] == 'phpactor' if record['ecosystem'] == 'composer' else any(
                p['name'] == record['name'] and p['version'] == record['version']
                for p in inventories.get(tool['id'], []))
            if not included:
                continue
            scopes.append({'tool': tool['id'], 'version': tool['version'],
                           'artifacts': [{'id': a['id'], 'integrity': a['integrity'], 'platforms': a['platforms']} for a in tool['artifacts']],
                           'role': 'PHAR runtime source' if record['ecosystem'] == 'composer' else 'exact frozen source-lock inventory; embedding not inferred',
                           'targetOnlyExclusion': 'Windows GNU import libraries; not an offered execution target; retained as locked source evidence' if record['name'].startswith('winapi-') else None})
        record['toolScopes'] = scopes
        record['declarationDocumentation'] = 'https://getcomposer.org/doc/04-schema.md#license' if record['ecosystem'] == 'composer' else 'https://doc.rust-lang.org/stable/cargo/reference/manifest.html#the-license-and-license-file-fields'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--fixture', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    temporary = pathlib.Path('/tmp').resolve()
    for path in [args.root, args.fixture]:
        if not path.resolve().is_relative_to(temporary) or path.resolve() == temporary:
            parser.error('Private temporary roots required')
    cache = args.root / 'legal-cache'
    cache.mkdir(parents=True, exist_ok=True)
    ref = '31ba1a50e5397e00a304dbadc76531740e89ee48'
    standards = {}
    for name in ['MIT', 'Apache-2.0']:
        url = 'https://raw.githubusercontent.com/spdx/license-list-data/' + ref + '/text/' + name + '.txt'
        standards[name] = {'source': url, 'notice': legal.save_notice(name + '-reference.txt', legal.download(url, cache), args.output)}
    records = []
    inventory = json.loads((args.output / 'cargo-notice-sources.json').read_text())
    for package in inventory:
        if package.get('source', {}).get('notices') or package.get('source', {}).get('legalHeaders'):
            continue
        identity = package['name'] + '-' + package['version']
        data = (args.fixture / 'crates' / (identity + '.crate')).read_bytes()
        if hashlib.sha256(data).hexdigest() != package['crateSha256']:
            raise ValueError('Crate integrity')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            raw = archive.extractfile(identity + '/Cargo.toml').read()
            manifest = tomllib.loads(raw.decode())['package']
        notice = legal.save_notice(identity + '/Cargo.toml#license-declaration', raw, args.output)
        records.append({'ecosystem': 'cargo', 'name': manifest['name'], 'version': manifest['version'],
                        'archiveIntegrity': 'sha256:' + package['crateSha256'],
                        'archiveUrl': 'https://static.crates.io/crates/' + manifest['name'] + '/' + identity + '.crate',
                        'declaredLicense': manifest['license'], 'authors': manifest.get('authors', []),
                        'declaration': notice, 'standardTerms': standards,
                        'review': 'A1 must review exact metadata-grant packaging; no synthesized copyright owner/year or silent replacement of upstream notices.',
                        'omission': 'Immutable published crate supplies no standalone legal file; retain its exact manifest grant, available authors and full standard terms separately.'})
    php = json.loads((args.output / 'php-notice-sources.json').read_text())
    for package in php:
        if package['source']['notices']:
            continue
        data = legal.download(package['source']['url'], cache)
        if hashlib.sha256(data).hexdigest() != package['source']['sha256']:
            raise ValueError('Composer source archive integrity')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = [p for p in archive.namelist() if len(p.split('/')) == 2 and p.endswith('/composer.json')]
            raw = archive.read(names[0])
            manifest = json.loads(raw)
        records.append({'ecosystem': 'composer', 'name': package['name'], 'version': package['version'],
                        'archiveIntegrity': 'sha256:' + package['source']['sha256'],
                        'archiveUrl': package['source']['url'], 'declaredLicense': manifest['license'],
                        'authors': manifest.get('authors', []),
                        'declaration': legal.save_notice(package['name'] + '/composer.json#license-declaration', raw, args.output),
                        'standardTerms': {'MIT': standards['MIT']},
                        'review': 'A1 must review exact metadata-grant packaging; no synthesized copyright owner/year.',
                        'omission': 'Pinned source archive supplies no standalone license; preserve exact MIT grant/author metadata and standard terms.'})
    enrich(records, inventory, php, args, cache)
    (args.output / 'metadata-license-grants.json').write_text(json.dumps(records, indent=2) + '\n')
    print('Exact metadata-grant records:', len(records), 'SPDX text commit:', ref)


if __name__ == '__main__':
    main()
