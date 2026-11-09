"""Inspect native container and linker/debug provenance, never execute foreign binaries."""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import struct
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


def cstring(data, offset):
    return data[offset:data.index(b'\0', offset)].decode()


def libraries(data):
    if data[:4] == b'\x7fELF' and data[4] == 2:
        order = '<' if data[5] == 1 else '>'
        shoff = struct.unpack_from(order + 'Q', data, 40)[0]
        size, count, names_index = struct.unpack_from(order + 'HHH', data, 58)
        sections = [struct.unpack_from(order + 'IIQQQQIIQQ', data, shoff + i * size)
                    for i in range(count)]
        strings = sections[names_index]
        names = data[strings[4]:strings[4] + strings[5]]
        named = {cstring(names, s[0]): s for s in sections}
        if '.dynamic' not in named:
            return []
        dynamic, strings = named['.dynamic'], named['.dynstr']
        values = data[strings[4]:strings[4] + strings[5]]
        return [cstring(values, value) for tag, value in
                struct.iter_unpack(order + 'qQ', data[dynamic[4]:dynamic[4] + dynamic[5]]) if tag == 1]
    if data[:4] == b'\xcf\xfa\xed\xfe':
        count = struct.unpack_from('<I', data, 16)[0]
        offset = 32
        result = []
        for _ in range(count):
            command, size = struct.unpack_from('<II', data, offset)
            if command in [12, 0x80000018, 0x8000001f]:
                name = struct.unpack_from('<I', data, offset + 8)[0]
                result.append(cstring(data, offset + name))
            offset += size
        return result
    raise ValueError('Unsupported binary metadata format')


def binary(artifact, data):
    if artifact['format'] == 'gz':
        return gzip.decompress(data)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        candidates = [m for m in archive.getmembers() if m.isfile() and
                      pathlib.PurePosixPath(m.name).name == pathlib.PurePosixPath(artifact['entry']).name]
        if len(candidates) != 1:
            raise ValueError('Ambiguous binary entry')
        return archive.extractfile(candidates[0]).read()


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
    records = []
    for tool in catalog['tools']:
        if tool['id'] not in ['ruff', 'rust-analyzer', 'lua-language-server', 'shellcheck']:
            continue
        for artifact in tool['artifacts']:
            data = legal.download(artifact['url'], cache)
            if 'sha256:' + hashlib.sha256(data).hexdigest() != artifact['integrity']:
                raise ValueError('Artifact integrity')
            executable = binary(artifact, data)
            compiler = sorted({x.decode() for x in re.findall(rb'/rustc/([a-f0-9]{40})', executable)})
            records.append({'tool': tool['id'], 'artifactId': artifact['id'],
                            'integrity': artifact['integrity'], 'binarySha256': hashlib.sha256(executable).hexdigest(),
                            'systemLibraries': libraries(executable), 'rustcSourceCommits': compiler})
            print(artifact['id'], records[-1]['systemLibraries'], compiler, flush=True)
            # Re-downloadable Attempt cache only; preserve metadata receipts, not binary copies.
            (cache / hashlib.sha256(artifact['url'].encode()).hexdigest()).unlink()
    (args.output / 'native-linkage.json').write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
