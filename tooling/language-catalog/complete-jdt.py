"""Bind shipped JAR identities to exact source/legal archives; read no implementation."""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
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


def coordinates(jar, name):
    properties = [p for p in jar.namelist() if p.endswith('/pom.properties')]
    if properties:
        fields = dict(re.findall(r'^(groupId|artifactId|version)=(.*)$',
                                 jar.read(properties[0]).decode(), re.M))
        return [fields['groupId'], fields['artifactId'], fields['version']]
    asm = {'org.objectweb.asm': 'asm', 'org.objectweb.asm.tree': 'asm-tree',
           'org.objectweb.asm.tree.analysis': 'asm-analysis',
           'org.objectweb.asm.util': 'asm-util', 'org.objectweb.asm.commons': 'asm-commons'}
    symbol, version = name.removesuffix('.jar').rsplit('_', 1)
    if symbol in asm:
        return ['org.ow2.asm', asm[symbol], version]
    special = {
        'com.sun.jna': ['net.java.dev.jna', 'jna', '5.19.1'],
        'com.sun.jna.platform': ['net.java.dev.jna', 'jna-platform', '5.19.1'],
        'org.apache.ant': ['org.apache.ant', 'ant', '1.10.17'],
        'org.eclipse.lsp4j': ['org.eclipse.lsp4j', 'org.eclipse.lsp4j', '1.0.0'],
        'org.eclipse.lsp4j.jsonrpc': ['org.eclipse.lsp4j', 'org.eclipse.lsp4j.jsonrpc', '1.0.0'],
        'org.hamcrest': ['org.hamcrest', 'hamcrest', '3.0'],
        'org.junit': ['junit', 'junit', '4.13.2'],
        'wrapped.com.jetbrains.intellij.java.java-decompiler-engine':
            ['com.jetbrains.intellij.java', 'java-decompiler-engine', '253.29346.240'],
    }
    if symbol in special:
        return special[symbol]
    if symbol == 'wrapped.org.jetbrains.annotations':
        return ['org.jetbrains', 'annotations', version]
    return None


def collect(path, cache, output):
    result = {'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    with zipfile.ZipFile(path) as jar:
        manifest = jar.read('META-INF/MANIFEST.MF').decode().replace('\r\n ', '')
        ref = re.search(r'^Eclipse-SourceReferences: (.*)', manifest, re.M)
        result['licenseDeclarations'] = re.findall(r'^Bundle-License: (.*)', manifest, re.M)
        if ref:
            result['sourceReference'] = ref[1].strip()
            repo = re.search(r'https://github.com/([^;]+?)\.git', ref[1])
            commit = re.search(r'commitId=([a-f0-9]{40})', ref[1])
            if repo and commit:
                repository = repo[1].replace('eclipse.jdt.ls/eclipse.jdt.javac', 'eclipse-jdtls/eclipse.jdt.javac')
                url = 'https://codeload.github.com/' + repository + '/tar.gz/' + commit[1]
            else:
                result['missingEvidence'] = ['Unsupported source reference']
                return result
        else:
            coord = coordinates(jar, path.name)
            if not coord:
                result['missingEvidence'] = ['No exact source reference or Maven coordinates']
                return result
            result['maven'] = coord
            group, artifact, version = coord
            base = 'https://repo.maven.apache.org/maven2/'
            if group == 'com.jetbrains.intellij.java':
                base = 'https://www.jetbrains.com/intellij-repository/releases/'
            url = (base + group.replace('.', '/') + '/' +
                   artifact + '/' + version + '/' + artifact + '-' + version + '-sources.jar')
        try:
            result['source'] = legal.source_record(url, cache, output)
        except Exception as error:
            result['missingEvidence'] = [str(error)]
        return result


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
    paths = sorted((args.fixture / 'native/jdt/plugins').glob('*.jar'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda p: collect(p, cache, args.output), paths))
    (args.output / 'jdt-source-closure.json').write_text(json.dumps(results, indent=2) + '\n')
    print('JARs', len(results), 'missing source', sum('missingEvidence' in x for x in results))


if __name__ == '__main__':
    main()
