"""Capture exact compiler Gitlinks and complete libunwind source/legal trees without checkout."""
import argparse
import hashlib
import io
import json
import os
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
search = load('search', str(pathlib.Path(__file__).with_name('legal-search.py')))
parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
temporary = pathlib.Path('/tmp').resolve()
if not args.root.resolve().is_relative_to(temporary) or args.root.resolve() == temporary:
    parser.error('Private temporary root required')
cache = args.root / 'legal-cache'
cache.mkdir(parents=True, exist_ok=True)
env = {'PATH': os.environ['PATH'], 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/usr/bin/false', 'GIT_NO_LAZY_FETCH': '1'}


def git(repository, *arguments):
    return subprocess.run(['git', '--git-dir=' + str(repository), '-c', 'credential.helper=', *arguments],
                          env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180).stdout


def metadata(repository, commit):
    destination = args.root / (repository.replace('/', '-') + '.git')
    if not destination.exists():
        subprocess.run(['git', 'init', '--bare', str(destination)], env=env, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    probe = subprocess.run(['git', '--git-dir=' + str(destination), 'cat-file', '-e', commit + '^{commit}'],
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if probe.returncode:
        git(destination, 'fetch', '--depth=1', '--filter=blob:none', 'https://github.com/' + repository + '.git', commit)
    if git(destination, 'rev-parse', commit + '^{commit}').decode().strip() != commit:
        raise ValueError('Git commit identity')
    return destination


def tree(repository, commit, path, recursive=False):
    command = ['ls-tree', '-z']
    if recursive:
        command.append('-r')
    command.extend([commit, '--', path])
    rows = []
    for row in git(repository, *command).split(b'\0'):
        if not row:
            continue
        fields, name = row.split(b'\t', 1)
        mode, kind, identity = fields.decode().split(' ')
        rows.append({'path': name.decode(), 'mode': mode, 'kind': kind, 'sha': identity})
    return rows


sources = json.loads((args.output / 'rust-runtime-sources.json').read_text())
records = []
for compiler in sources:
    rust = metadata('rust-lang/rust', compiler)
    links = {path: tree(rust, compiler, path)[0]['sha'] for path in ('src/llvm-project', 'library/backtrace')}
    llvm_commit = links['src/llvm-project']
    llvm = metadata('rust-lang/llvm-project', llvm_commit)
    unwind_tree = tree(llvm, llvm_commit, 'libunwind')[0]['sha']
    files = []
    for row in tree(llvm, llvm_commit, 'libunwind', recursive=True):
        if row['kind'] != 'blob' or row['mode'] not in ('100644', '100755'):
            raise ValueError('Unsupported source-tree entry')
        content = legal.download('https://raw.githubusercontent.com/rust-lang/llvm-project/' + llvm_commit + '/' + row['path'], cache)
        if hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest() != row['sha']:
            raise ValueError('Git blob integrity')
        files.append((row['path'], int(row['mode'], 8) & 0o777, content, row['sha']))
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path, mode, content, blob in sorted(files):
            entry = tarfile.TarInfo(path)
            entry.size = len(content)
            entry.mode = mode
            archive.addfile(entry, io.BytesIO(content))
    payload = stream.getvalue()
    archive_path = args.root / ('libunwind-' + unwind_tree + '.tar')
    archive_path.write_bytes(payload)
    inspected = search.search(payload, args.output)
    llvm_license = legal.download('https://raw.githubusercontent.com/rust-lang/llvm-project/' + llvm_commit + '/LICENSE.TXT', cache)
    license_blob = tree(llvm, llvm_commit, 'LICENSE.TXT')[0]['sha']
    if hashlib.sha1(b'blob ' + str(len(llvm_license)).encode() + b'\0' + llvm_license).hexdigest() != license_blob:
        raise ValueError('Root license Git blob integrity')
    backtrace = legal.source_record('https://codeload.github.com/rust-lang/backtrace-rs/tar.gz/' + links['library/backtrace'], cache, args.output)
    records.append({'rustSourceCommit': compiler, 'llvmSourceCommit': llvm_commit, 'libunwindTree': unwind_tree,
                    'sourceUrl': 'https://github.com/rust-lang/llvm-project/tree/' + llvm_commit + '/libunwind',
                    'sourceArchiveSha256': hashlib.sha256(payload).hexdigest(), 'sourceArchiveBytes': len(payload),
                    'archiveFormat': 'Canonical USTAR sorted path, original modes, uid/gid/mtime zero; complete tree verified against Git blobs.',
                    'files': [{'path': path, 'gitBlob': blob, 'sha256': hashlib.sha256(content).hexdigest(), 'mode': mode}
                              for path, mode, content, blob in sorted(files)], 'legalSearch': inspected,
                    'llvmLicense': legal.save_notice('LICENSE.TXT', llvm_license, args.output),
                    'backtraceGitlink': links['library/backtrace'], 'backtraceSource': backtrace,
                    'scope': 'Exact complete compiler-declared libunwind source/legal tree and backtrace source. Historical binary target-builder/runtime membership is not attested.'})
    print(compiler, llvm_commit, len(files), len(payload), flush=True)
(args.output / 'rust-target-sources.json').write_text(json.dumps(records, indent=2) + '\n')
