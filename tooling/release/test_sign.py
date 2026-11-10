"""The release signer's hand-off checks, on crafted hand-offs.

Run: python3 -I -m unittest discover -s tooling/release -p 'test_*.py'
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sign

DIST = sign.DAEMON_DIST
FRAMEWORK = f"{sign.FRAMEWORKS}/Fake.framework"


def entry(name: str, kind: bytes = tarfile.REGTYPE, data: bytes = b"", link: str = "", mode: int = 0o644):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = link
    info.mode = mode
    info.size = len(data) if kind == tarfile.REGTYPE else 0
    return info, data


def directory(name: str):
    return entry(name, tarfile.DIRTYPE, mode=0o755)


def symlink(name: str, target: str):
    return entry(name, tarfile.SYMTYPE, link=target, mode=0o777)


class Handoff(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.outside = self.root / "outside"
        self.outside.mkdir()
        (self.outside / "secret").write_bytes(b"not the hand-off's")
        self.out = self.root / "out"
        self.out.mkdir()

    def archive(self, *entries) -> tuple:
        path = self.root / "release-bundle.tar"
        with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as tar:
            for info, data in entries:
                tar.addfile(info, io.BytesIO(data) if info.isreg() else None)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def unpack(self, *entries) -> Path:
        path, digest = self.archive(*entries)
        return sign.unpack_handoff(path, digest, self.out / "tree")

    def refuses(self, message: str, *entries) -> None:
        with self.assertRaises(SystemExit) as raised:
            self.unpack(*entries)
        self.assertIn(message, str(raised.exception))
        self.assertEqual(sorted(p.name for p in self.outside.iterdir()), ["secret"])
        self.assertEqual((self.outside / "secret").read_bytes(), b"not the hand-off's")

    def test_unpacks_an_electron_framework_with_its_own_symlinks(self) -> None:
        tree = self.unpack(
            directory(DIST),
            entry(f"{DIST}/manifest.json", data=b"{}", mode=0o4755),
            directory(f"{FRAMEWORK}/Versions/A/Resources"),
            entry(f"{FRAMEWORK}/Versions/A/Fake", data=b"code", mode=0o755),
            symlink(f"{FRAMEWORK}/Versions/Current", "A"),
            symlink(f"{FRAMEWORK}/Fake", "Versions/Current/Fake"),
            symlink(f"{FRAMEWORK}/Resources", "Versions/Current/Resources"),
        )

        self.assertEqual(stat.S_IMODE(os.stat(tree / DIST / "manifest.json").st_mode), 0o755)
        self.assertEqual(os.readlink(tree / FRAMEWORK / "Fake"), "Versions/Current/Fake")
        self.assertEqual((tree / FRAMEWORK / "Fake").read_bytes(), b"code")

    def test_refuses_a_name_that_climbs_out(self) -> None:
        for name in (f"{DIST}/../../../../../outside/secret", "../outside/planted", f"{DIST}/./x"):
            with self.subTest(name=name):
                self.refuses("is not a relative path inside it", entry(name, data=b"planted"))
                self.reset_out()

    def test_refuses_an_absolute_name(self) -> None:
        self.refuses("is not a relative path inside it", entry(f"{self.outside}/planted", data=b"x"))

    def test_refuses_an_entry_outside_the_two_roots(self) -> None:
        self.refuses("is outside", entry("apps/desktop/package.json", data=b"{}"))

    def test_refuses_a_symlink_out_of_the_hand_off(self) -> None:
        for target in (str(self.outside / "secret"), "../../../../../../../outside/secret"):
            with self.subTest(target=target):
                self.refuses(
                    "points outside the app's Frameworks",
                    directory(f"{DIST}/darwin-arm64"),
                    symlink(f"{DIST}/darwin-arm64/polaris", target),
                )
                self.reset_out()

    def test_refuses_framework_symlinks_that_point_outside_the_bundle(self) -> None:
        for name, target in (
            (f"{FRAMEWORK}/Versions/Current", "../../../../../../../../../../../outside"),
            (f"{FRAMEWORK}/Fake", str(self.outside / "secret")),
            (sign.FRAMEWORKS, str(self.outside)),
            (f"{FRAMEWORK}/Resources", "../../Resources"),
        ):
            with self.subTest(name=name):
                self.refuses("points outside the app's Frameworks", symlink(name, target))
                self.reset_out()

    def test_refuses_a_framework_symlink_that_resolves_nowhere(self) -> None:
        self.refuses("does not resolve inside", symlink(f"{FRAMEWORK}/Fake", "Versions/Current/Fake"))

    def test_refuses_an_entry_written_through_a_symlink(self) -> None:
        self.refuses(
            "is inside a symlink",
            directory(f"{FRAMEWORK}/Versions/A"),
            symlink(f"{FRAMEWORK}/Versions/Current", "A"),
            entry(f"{FRAMEWORK}/Versions/Current/Fake", data=b"through the link"),
        )

    def test_refuses_hard_links_and_special_files(self) -> None:
        for kind in (tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE):
            with self.subTest(kind=kind):
                link = str(self.outside / "secret") if kind == tarfile.LNKTYPE else ""
                self.refuses(
                    "is not a regular file, directory or symlink",
                    entry(f"{DIST}/manifest.json", kind, link=link),
                )
                self.reset_out()

    def test_refuses_a_repeated_entry(self) -> None:
        self.refuses(
            "repeats an entry",
            entry(f"{DIST}/manifest.json", data=b"{}"),
            entry(f"{DIST}/manifest.json", data=b"{}"),
        )

    def test_refuses_a_hand_off_whose_digest_differs(self) -> None:
        path, _ = self.archive(entry(f"{DIST}/manifest.json", data=b"{}"))
        with self.assertRaises(SystemExit) as raised:
            sign.unpack_handoff(path, "0" * 64, self.out / "tree")
        self.assertIn("is not the", str(raised.exception))
        self.assertFalse((self.out / "tree" / "apps").exists())

    def test_writes_only_into_a_directory_it_creates(self) -> None:
        tree = self.out / "tree"
        tree.mkdir()
        os.symlink(self.outside, tree / "apps")
        with self.assertRaises(SystemExit) as raised:
            self.unpack(entry(f"{DIST}/manifest.json", data=b"{}"))
        self.assertIn("already exists", str(raised.exception))
        self.assertEqual(sorted(p.name for p in self.outside.iterdir()), ["secret"])

    def reset_out(self) -> None:
        for path in sorted(self.out.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if path.is_dir() and not path.is_symlink():
                path.rmdir()
            else:
                path.unlink()


class Manifest(unittest.TestCase):
    def test_refuses_names_that_reach_outside_the_dist(self) -> None:
        good = {"binary": "polaris", "files": {"polaris": {}}, "archive": {"name": "polaris.tar.gz"}}
        cases = {
            "file": {**good, "files": {"polaris": {}, "../../../outside/secret": {}}},
            "binary": {**good, "binary": "../polaris"},
            "archive": {**good, "archive": {"name": "../../release.tar.gz"}},
        }
        for what, build in cases.items():
            with self.subTest(what=what), tempfile.TemporaryDirectory() as dist:
                manifest = {"version": "1.0.0", "platforms": {sign.PLATFORM: build}}
                Path(dist, "manifest.json").write_text(json.dumps(manifest))
                with self.assertRaises(SystemExit) as raised:
                    sign.read_manifest(Path(dist), "1.0.0")
                self.assertIn("is not a plain file name", str(raised.exception))

    def test_reads_a_bundle_path_and_refuses_one_that_climbs_out(self) -> None:
        bundled = "PolarisDaemon.app/Contents/_CodeSignature/CodeResources"
        self.assertEqual(
            sign.file_path(Path("/dist/darwin-arm64"), "CodeResources", {"path": bundled}),
            Path("/dist/darwin-arm64", bundled),
        )
        helper = "Polaris Computer Use.app/Contents/MacOS/polaris-computer-use"
        self.assertEqual(
            sign.file_path(Path("/dist/darwin-arm64"), "polaris-computer-use", {"path": helper}),
            Path("/dist/darwin-arm64", helper),
        )
        for path in (
            "../../outside/polaris", "/etc/passwd", "PolarisDaemon.app/../../x", "a//b", 7,
            " leading/polaris", "trailing /polaris", ". ./polaris",
        ):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as dist:
                build = {"binary": "polaris", "files": {"polaris": {"path": path}}}
                manifest = {"version": "1.0.0", "platforms": {sign.PLATFORM: build}}
                Path(dist, "manifest.json").write_text(json.dumps(manifest))
                with self.assertRaises(SystemExit) as raised:
                    sign.read_manifest(Path(dist), "1.0.0")
                self.assertIn("is not a relative path inside its platform", str(raised.exception))


class Helper(unittest.TestCase):
    """Where the computer use helper app must be before anything is signed."""

    DAEMON = Path("/dist/darwin-arm64/PolarisDaemon.app")

    def paths(self, bundle: str = "Polaris Computer Use.app", **moved: str) -> dict:
        macos = Path("/dist/darwin-arm64", bundle, "Contents/MacOS")
        names = (sign.HELPER_LAUNCHER, *sign.HELPER_TOOLS)
        return {name: Path(moved[name]) if name in moved else macos / name for name in names}

    def refused(self, paths: dict) -> str:
        with self.assertRaises(SystemExit) as raised:
            sign.helper_of(paths, self.DAEMON)
        return str(raised.exception)

    def test_finds_the_helper_beside_the_daemon_s_bundle(self) -> None:
        self.assertEqual(
            sign.helper_of(self.paths(), self.DAEMON),
            Path("/dist/darwin-arm64/Polaris Computer Use.app"),
        )

    def test_refuses_a_build_without_one_of_its_files(self) -> None:
        for name in (sign.HELPER_LAUNCHER, *sign.HELPER_TOOLS):
            with self.subTest(name=name):
                paths = self.paths()
                del paths[name]
                self.assertIn("missing darwin-arm64 computer use helper", self.refused(paths))

    def test_refuses_a_helper_under_another_name_or_place(self) -> None:
        self.assertIn("is not Polaris Computer Use.app", self.refused(self.paths("Other.app")))
        nested = self.paths("PolarisDaemon.app/Contents/Polaris Computer Use.app")
        self.assertIn("beside the Daemon", self.refused(nested))

    def test_refuses_a_tool_outside_the_helper(self) -> None:
        outside = self.paths(**{"agent-desktop": "/dist/darwin-arm64/agent-desktop"})
        self.assertIn("agent-desktop is not beside the helper's launcher", self.refused(outside))


if __name__ == "__main__":
    unittest.main()


class Staple(unittest.TestCase):
    def result(self, code: int, out: str = ""):
        return mock.Mock(returncode=code, stdout=out, stderr="")

    def test_retries_until_the_ticket_is_stapled_and_validates(self) -> None:
        tries = [self.result(65, "Could not validate ticket"), self.result(65),
                 self.result(0), self.result(65, "does not have a ticket stapled to it"),
                 self.result(0), self.result(0)]
        waits: list = []
        with mock.patch.object(sign.subprocess, "run", side_effect=tries) as calls:
            sign.staple(Path("Polaris.app"), wait=waits.append)
        self.assertEqual(waits, [20, 40, 60])
        self.assertEqual(calls.call_args.args[0], ["xcrun", "stapler", "validate", "Polaris.app"])

    def test_names_validate_s_reason_when_a_staple_never_validates(self) -> None:
        tries = [self.result(0), self.result(65, "Processing: x\nx does not have a ticket")]
        with mock.patch.object(sign.subprocess, "run", side_effect=tries * sign.STAPLE_TRIES), \
                self.assertRaisesRegex(SystemExit, "x does not have a ticket"):
            sign.staple(Path("Polaris.app"), wait=lambda _: None)

    def test_names_stapler_s_own_reason_when_it_never_staples(self) -> None:
        failing = [self.result(65, "Processing: x\nCould not validate ticket for x")] * sign.STAPLE_TRIES
        with mock.patch.object(sign.subprocess, "run", side_effect=failing), \
                self.assertRaisesRegex(SystemExit, "Could not validate ticket for x"):
            sign.staple(Path("Polaris.app"), wait=lambda _: None)
