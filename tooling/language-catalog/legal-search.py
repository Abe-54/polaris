"""Inspect only legal filenames, license sections and copyright/license comment blocks."""
import hashlib
import io
import pathlib
import re
import tarfile
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


def search(data, output, scope=None):
    notices = []
    headers = []
    names = []
    if data[:2] == b'PK':
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = [(name, lambda name=name: archive.read(name)) for name in archive.namelist() if not name.endswith('/')]
    else:
        archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
        entries = [(member.name, lambda member=member: archive.extractfile(member).read())
                   for member in archive.getmembers() if member.isfile()]
    with archive:
        for name, read in entries:
            names.append(name)
            relative = name.split('/', 1)[-1]
            if legal.legal_name(name):
                notices.append(legal.save_notice(name, read(), output))
            if scope and not relative.startswith(scope.rstrip('/') + '/'):
                continue
            if pathlib.PurePosixPath(name).name.lower().startswith('readme'):
                text = read()
                for section in re.finditer(br'(?im)^#{1,6}\s+licen[sc]e[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|\Z)', text):
                    headers.append(legal.save_notice(name + '#license-section', section[0], output))
            if not name.endswith(('.rs', '.php', '.c', '.h', '.cpp', '.hpp', '.lua', '.java')):
                continue
            text = read()
            blocks = re.findall(br'(?m)/\*[\s\S]*?\*/|(?:^\s*//[^\n]*\n)+|(?:^\s*--[^\n]*\n)+', text)
            for block in blocks:
                if not re.search(br'copyright|SPDX-License-Identifier|permission is hereby granted|licensed under', block, re.I):
                    continue
                if b'```' in block:
                    block = b'\n'.join(line for line in block.splitlines() if re.search(br'copyright|SPDX-License-Identifier|licensed under', line, re.I))
                headers.append(legal.save_notice(name + '#legal-comment', block, output))
    return {'searchVersion': 'legal-only-v1', 'filesSearched': len(names),
            'fileNameInventorySha256': hashlib.sha256('\n'.join(sorted(names)).encode()).hexdigest(),
            'scope': scope or 'entire immutable published archive',
            'standaloneLegalFiles': notices, 'legalCommentsAndSections': list({r['sha256']: r for r in headers}.values())}
