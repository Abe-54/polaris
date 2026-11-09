"""Synthetic poison and process faults: no real home, account or service."""
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from fixture import temporary_root, npm_environment, server_environment, start, stop, run, group_exists


def wait_for_text(path, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.is_file() and (text := path.read_text()):
            return text
        time.sleep(0.02)
    raise AssertionError(f'{path.name} not written within {seconds} s')


class FixtureTest(unittest.TestCase):
    def test_canonical_temporary_paths(self):
        self.assertEqual(temporary_root('/tmp/k1-path'), pathlib.Path('/tmp/k1-path').resolve())
        for invalid in ('/tmp', '/', '/tmp/../etc', '/tmpx/k1'):
            with self.assertRaises(ValueError):
                temporary_root(invalid)

    def test_environment_drops_poison_without_home_overrides(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as name:
            root = pathlib.Path(name)
            with patch.dict(os.environ, {'NPM_TOKEN': 'synthetic',
                    'npm_config_registry': 'http://127.0.0.1:9', 'NODE_OPTIONS': '--unused',
                    'GITHUB_TOKEN': 'synthetic', 'SQLLENS_USER_CONFIG': '/unused-config'}):
                install = npm_environment(root)
                server = server_environment(root)
            for env in (install, server):
                self.assertNotIn('HOME', env)
                self.assertNotIn('NPM_TOKEN', env)
                self.assertNotIn('GITHUB_TOKEN', env)
                self.assertNotIn('NODE_OPTIONS', env)
            self.assertEqual(install['npm_config_registry'], 'https://registry.npmjs.org/')
            self.assertTrue(pathlib.Path(install['npm_config_userconfig']).is_file())
            self.assertNotEqual(install['npm_config_userconfig'], install['npm_config_globalconfig'])
            self.assertEqual(server['SQLLENS_USER_CONFIG'], str(root / 'config/sqllens.json'))

    def test_parent_and_term_resistant_descendant_cleanup(self):
        worker = """import os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pid = os.fork()
if pid == 0:
    while True: time.sleep(.1)
open('group.txt', 'w').write(str(os.getpgrp()))
if sys.argv[1] != 'timeout': sys.exit(int(sys.argv[1]))
while True: time.sleep(.1)
"""
        with tempfile.TemporaryDirectory(dir='/tmp') as name:
            for outcome in ('0', '1', 'timeout'):
                root = pathlib.Path(name) / outcome
                root.mkdir()
                process = start([sys.executable, '-c', worker, outcome], root, server_environment(root))
                try:
                    # group.txt follows SIG_IGN and the fork: cleanup must not race the worker's startup.
                    self.assertEqual(wait_for_text(root / 'group.txt', 10), str(process.pid))
                    if outcome != 'timeout':
                        process.wait(timeout=10)
                    self.assertTrue(group_exists(process.pid))
                finally:
                    proof = stop(process)
                    for pipe in (process.stdin, process.stdout, process.stderr):
                        pipe.close()
                self.assertTrue(proof['groupReaped'])
                self.assertFalse(group_exists(process.pid))
                self.assertEqual(process.returncode, -9 if outcome == 'timeout' else int(outcome))

    def test_installer_timeout_reaps_group(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as name:
            root = pathlib.Path(name)
            command = [sys.executable, '-c', "import os,time; open('pid', 'w').write(str(os.getpid())); time.sleep(10)"]
            with self.assertRaises(subprocess.TimeoutExpired):
                run(command, root, npm_environment(root), .2)
            self.assertFalse(group_exists(int((root / 'pid').read_text())))


if __name__ == '__main__':
    unittest.main()
