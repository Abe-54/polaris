"""Sign, notarise and staple the macOS release outputs for release.yml.

The only release code that sees Apple credentials (docs/adr/0057). release.yml runs
it from the default branch on artifacts built without credentials, and it uses only
the standard library and Apple's tools: no dependencies, no repository build code.

  sign.py app --handoff release-bundle.tar --sha256 HEX --out DIR --entitlements DIR --version V
      checks the build's hand-off against the digest its job recorded, unpacks it into
      DIR/tree, signs the darwin-arm64 Daemon and its computer use helper app, records
      their new bytes in the manifests
      and the Release archive, signs the app from the inside out, notarises and staples
      it, and writes the signed hand-off to DIR/handoff and its digests to DIR/digests.
  sign.py dmg --dmg Polaris-V-arm64.dmg --sha256 HEX --out DIR
      checks, signs, notarises and staples a copy of the installer image in DIR/assets.

The hand-off ran repository code, so it is hostile input: it must hold only plain
directories and files under the two expected roots, and symlinks only inside the
app's Frameworks that resolve there. DIR must not exist; the signer creates it and
writes nowhere else.

Credentials come from the environment: MACOS_CERT_P12 (base64), MACOS_CERT_PASSWORD,
APPLE_API_KEY (the .p8 contents), APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_TEAM_ID
and optionally MACOS_SIGNING_IDENTITY. They live in a temporary keychain and files
that are deleted before the script exits. --ad-hoc signs with "-" and skips
notarisation instead: a local dry run that needs no credentials.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import gzip
import hashlib
import hmac
import json
import os
import plistlib
import posixpath
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

PLATFORM = "darwin-arm64"
DAEMON_ENTITLEMENTS = {"polaris": "daemon.plist", "betterleaks": "betterleaks.plist"}
# Where the Daemon's bundle holds the native libraries it loads.
DAEMON_LIBRARIES = "Contents/Frameworks"
APP_ENTITLEMENTS = "electron.plist"
# "Polaris Computer Use.app" beside the Daemon's bundle: its launcher and the tools it runs (ENG-846).
HELPER_APP = "Polaris Computer Use.app"
HELPER_LAUNCHER = "polaris-computer-use"
HELPER_TOOLS = ("agent-desktop", "agent-desktop-macos-helper")
HELPER_ENTITLEMENTS = "computer-use.plist"
# The hand-off's only roots, as the build job tars them.
DAEMON_DIST = "apps/daemon/dist"
APP = "apps/desktop/out/dist/Polaris-darwin-arm64/Polaris.app"
FRAMEWORKS = f"{APP}/Contents/Frameworks"
REQUIRED = (
    "MACOS_CERT_P12",
    "MACOS_CERT_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_TEAM_ID",
)
MACHO = {bytes.fromhex(m) for m in ("feedface", "feedfacf", "cefaedfe", "cffaedfe")}
FAT = {bytes.fromhex(m) for m in ("cafebabe", "cafebabf")}
BLOCK = 512
# packages/client/src/install/archive.ts: the same fixed mtime keeps archives reproducible.
MTIME = 1_767_225_600
PLAIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*")
# One component of a manifest file's `path` in its platform directory (`_CodeSignature` too);
# spaces only inside it, as in the helper app's folder name.
PATH_PART = re.compile(r"[A-Za-z0-9_](?:[A-Za-z0-9._+ -]*[A-Za-z0-9._+-])?")
SHA256 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class Notary:
    key: str
    key_id: str
    issuer: str


@dataclass(frozen=True)
class Signer:
    identity: str
    keychain: str | None
    timestamp: bool
    notary: Notary | None


def run(cmd: list, check: bool = True) -> str:
    result = subprocess.run([str(part) for part in cmd], capture_output=True, text=True)
    if check and result.returncode != 0:
        # Only the tool and subcommand: arguments may hold a password.
        raise SystemExit(f"{' '.join(map(str, cmd[:2]))} failed: {result.stderr.strip()}")
    return result.stdout


def plain(name, what: str) -> str:
    """A single file name with no path, '.' or '..' in it, as manifests and assets use."""
    if not isinstance(name, str) or not PLAIN.fullmatch(name):
        raise SystemExit(f'{what} "{name}" is not a plain file name')
    return name


def file_path(root: Path, name: str, entry: dict) -> Path:
    """Where a manifest file is under its platform directory: its relative `path`, else its name."""
    relative = entry.get("path", name)
    parts = relative.split("/") if isinstance(relative, str) else [None]
    if any(not isinstance(part, str) or not PATH_PART.fullmatch(part) or part in (".", "..") for part in parts):
        raise SystemExit(f'{name}: path "{relative}" is not a relative path inside its platform')
    return root.joinpath(*parts)


def app_bundle_of(executable: Path) -> Path:
    """The `.app` whose `Contents/MacOS` holds `executable`."""
    bundle = executable.parent.parent.parent
    if executable.parent.name != "MacOS" or executable.parent.parent.name != "Contents" or bundle.suffix != ".app":
        raise SystemExit(f"{PLATFORM}: {executable.name} is not in an app bundle")
    return bundle


def read_bytes(path: Path) -> bytes:
    """A regular file's bytes, never through a symlink at the last component."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise SystemExit(f"{path}: {error.strerror}") from None
    with os.fdopen(fd, "rb") as file:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SystemExit(f"{path}: not a regular file")
        return file.read()


def read_json(path: Path):
    return json.loads(read_bytes(path))


def write_json(path: Path, value) -> None:
    # The JSON.stringify(value, null, 2) layout packaging writes.
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def facts(path: Path) -> dict:
    data = read_bytes(path)
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def fresh_dir(path: Path) -> Path:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        raise SystemExit(f"{path} already exists: the signer writes only to a directory it creates") from None
    return path.resolve(strict=True)


def take_input(source: Path, expected: str, copy: Path) -> Path:
    """Copies a hand-off file into the signer's directory, then checks the copy's digest."""
    if not SHA256.fullmatch(expected or ""):
        raise SystemExit(f"{source.name}: the recorded digest is not a SHA-256")
    data = read_bytes(source)
    actual = hashlib.sha256(data).hexdigest()
    if not hmac.compare_digest(actual, expected):
        raise SystemExit(f"{source.name}: SHA-256 {actual} is not the {expected} its job recorded")
    with open(copy, "xb") as file:
        file.write(data)
    return copy


def member_name(member: tarfile.TarInfo) -> str:
    name = member.name.rstrip("/") if member.isdir() else member.name
    parts = name.split("/")
    if name.startswith("/") or "\\" in name or any(part in ("", ".", "..") for part in parts):
        raise SystemExit(f'hand-off entry "{member.name}" is not a relative path inside it')
    if not any(name == root or name.startswith(root + "/") for root in (DAEMON_DIST, APP)):
        raise SystemExit(f'hand-off entry "{name}" is outside {DAEMON_DIST} and the app')
    if not (member.isdir() or member.isreg() or member.issym()):
        raise SystemExit(f'hand-off entry "{name}" is not a regular file, directory or symlink')
    if member.issym():
        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
        if not name.startswith(FRAMEWORKS + "/") or member.linkname.startswith("/") or not (
            target.startswith(FRAMEWORKS + "/")
        ):
            raise SystemExit(f'hand-off symlink "{name}" points outside the app\'s Frameworks')
    return name


def checked_members(tar: tarfile.TarFile) -> list:
    members = [(member_name(member), member) for member in tar.getmembers()]
    names = [name for name, _ in members]
    if len(set(names)) != len(names):
        raise SystemExit("the hand-off repeats an entry")
    links = {name for name, member in members if member.issym()}
    for name in names:
        parts = name.split("/")
        if any("/".join(parts[:i]) in links for i in range(1, len(parts))):
            raise SystemExit(f'hand-off entry "{name}" is inside a symlink')
    return members


def make_dirs(root: Path, parts: list) -> Path:
    path = root
    for part in parts:
        path = path / part
        try:
            os.mkdir(path, 0o755)
        except FileExistsError:
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                raise SystemExit(f"{path.relative_to(root)}: not a directory") from None
    return path


def extract(archive: Path, tree: Path) -> list:
    """Directories and regular files, never through an existing path; symlinks are left out."""
    with tarfile.open(archive, "r:") as tar:
        members = checked_members(tar)
        for name, member in members:
            parts = name.split("/")
            if member.isdir():
                make_dirs(tree, parts)
            elif member.isreg():
                path = make_dirs(tree, parts[:-1]) / parts[-1]
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as file, tar.extractfile(member) as source:
                    shutil.copyfileobj(source, file)
                    os.fchmod(fd, member.mode & 0o755)
    return members


def unpack_handoff(archive: Path, sha256: str, dest: Path) -> Path:
    """Unpacks the build's hand-off into dest, which it creates, refusing anything unsafe."""
    tree = fresh_dir(dest)
    copy = take_input(archive, sha256, tree.parent / f".{tree.name}.tar")
    try:
        members = extract(copy, tree)
    finally:
        copy.unlink()
    links = [name for name, member in members if member.issym()]
    for name, member in members:
        if member.issym():
            parts = name.split("/")
            os.symlink(member.linkname, make_dirs(tree, parts[:-1]) / parts[-1])
    frameworks = tree / FRAMEWORKS
    for name in links:
        try:
            inside = (tree / name).resolve(strict=True).is_relative_to(frameworks.resolve(strict=True))
        except (OSError, RuntimeError):
            inside = False
        if not inside:
            raise SystemExit(f'hand-off symlink "{name}" does not resolve inside the app\'s Frameworks')
    return tree


def select_identity(output: str, team: str, wanted: str | None) -> str:
    found = re.findall(r'\b([0-9A-Fa-f]{40}) "(Developer ID Application: [^"\n]+)"', output)
    matches = [
        name
        for sha, name in found
        if name.endswith(f"({team})") and (not wanted or wanted in (name, sha))
    ]
    if len(set(matches)) != 1:
        raise SystemExit(
            "expected one valid Developer ID Application identity for APPLE_TEAM_ID; "
            "select with MACOS_SIGNING_IDENTITY"
        )
    return matches[0]


@contextlib.contextmanager
def credentials(env):
    missing = [name for name in REQUIRED if not env.get(name, "").strip()]
    if missing:
        raise SystemExit("missing signing secrets: " + ", ".join(missing))
    directory = Path(tempfile.mkdtemp(prefix="polaris-signing-"))
    keychain = directory / "release.keychain-db"
    original = shlex.split(run(["security", "list-keychains", "-d", "user"]))
    password = secrets.token_hex(32)
    print(f"::add-mask::{password}", flush=True)
    try:
        certificate = directory / "certificate.p12"
        certificate.write_bytes(base64.b64decode(env["MACOS_CERT_P12"]))
        key = directory / "AuthKey.p8"
        key.write_text(env["APPLE_API_KEY"])
        run(["security", "create-keychain", "-p", password, keychain])
        run(["security", "set-keychain-settings", "-lut", "21600", keychain])
        run(["security", "unlock-keychain", "-p", password, keychain])
        run(["security", "import", certificate, "-P", env["MACOS_CERT_PASSWORD"], "-k",
             keychain, "-t", "cert", "-f", "pkcs12", "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
        certificate.unlink()
        run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
             "-s", "-k", password, keychain])
        run(["security", "list-keychains", "-d", "user", "-s", keychain, *original])
        identities = run(["security", "find-identity", "-v", "-p", "codesigning", keychain])
        identity = select_identity(
            identities, env["APPLE_TEAM_ID"], env.get("MACOS_SIGNING_IDENTITY", "").strip()
        )
        notary = Notary(str(key), env["APPLE_API_KEY_ID"], env["APPLE_API_ISSUER"])
        yield Signer(identity, str(keychain), True, notary)
    finally:
        run(["security", "list-keychains", "-d", "user", "-s", *original], check=False)
        if keychain.exists():
            run(["security", "delete-keychain", keychain], check=False)
        shutil.rmtree(directory, ignore_errors=True)


def sign(signer: Signer, path: Path, entitlements: Path | None, runtime: bool = True) -> None:
    cmd = ["codesign", "--force", "--sign", signer.identity]
    if signer.keychain:
        cmd += ["--keychain", signer.keychain]
    if signer.timestamp:
        cmd.append("--timestamp")
    if runtime:
        cmd += ["--options", "runtime"]
    if entitlements is not None:
        cmd += ["--entitlements", entitlements]
    run([*cmd, path])
    run(["codesign", "--verify", "--strict", path])


def notarize(signer: Signer, path: Path, submission: Path) -> None:
    if signer.notary is None:
        return
    notary = signer.notary
    output = run(["xcrun", "notarytool", "submit", submission, "--key", notary.key,
                  "--key-id", notary.key_id, "--issuer", notary.issuer, "--wait",
                  "--output-format", "json"], check=False)
    try:
        result = json.loads(output)
    except json.JSONDecodeError:
        raise SystemExit(f"notarytool returned no result for {path.name}") from None
    if result.get("status") != "Accepted":
        raise SystemExit(
            f"{path.name} notarisation {result.get('status')}: submission {result.get('id')} "
            "(xcrun notarytool log <id> has Apple's reasons)"
        )
    staple(path)


STAPLE_TRIES = 6


def stapler(action: str, path: Path) -> str | None:
    """None when `xcrun stapler <action>` succeeds, else its last line of output."""
    # stapler reports its errors on stdout, and its arguments hold no secret.
    result = subprocess.run(["xcrun", "stapler", action, str(path)], capture_output=True, text=True)
    if result.returncode == 0:
        return None
    lines = (result.stdout + result.stderr).strip().splitlines()
    return lines[-1] if lines else "no output"


def staple(path: Path, wait=time.sleep) -> None:
    """Staples and validates the accepted ticket, retrying while Apple's CDN catches up."""
    reason = ""
    for attempt in range(STAPLE_TRIES):
        if attempt:
            wait(20 * attempt)
        reason = stapler("staple", path) or stapler("validate", path)
        if reason is None:
            return
    raise SystemExit(f"xcrun stapler could not staple {path.name}: {reason}")


def tar_header(name: str, mode: int, size: int) -> bytes:
    header = bytearray(BLOCK)

    def put(offset: int, value: bytes) -> None:
        header[offset:offset + len(value)] = value

    def octal(offset: int, length: int, value: int) -> None:
        put(offset, f"{value:0{length - 1}o}".encode() + b"\0")

    put(0, name.encode())
    octal(100, 8, mode)
    octal(108, 8, 0)
    octal(116, 8, 0)
    octal(124, 12, size)
    octal(136, 12, MTIME)
    header[156] = 0x30
    put(257, b"ustar\x0000")
    checksum = sum(0x20 if 148 <= i < 156 else byte for i, byte in enumerate(header))
    put(148, f"{checksum:06o}".encode() + b"\0 ")
    return bytes(header)


def pack_archive(entries: list) -> bytes:
    """The Release archive format of archive.ts: a gzipped ustar of plain files."""
    tar = bytearray()
    for name, mode, data in entries:
        if not name or len(name) >= 100 or re.search(r"[/\\\0]", name) or name in (".", ".."):
            raise SystemExit(f'archive entry name "{name}" is not plain')
        tar += tar_header(name, mode, len(data)) + data
        tar += bytes(-len(data) % BLOCK)
    tar += bytes(2 * BLOCK)
    return gzip.compress(bytes(tar), compresslevel=9, mtime=0)


def rewrite_archive(dist: Path, manifest: dict) -> None:
    build = manifest["platforms"][PLATFORM]
    archive = build.get("archive")
    if archive is None:
        raise SystemExit(f"{PLATFORM}: the release manifest records no archive")
    names = [build["binary"], *(name for name in build["files"] if name != build["binary"])]
    entries = [
        (name,
         0o755 if name == build["binary"] or build["files"][name].get("executable") else 0o644,
         read_bytes(file_path(dist / PLATFORM, name, build["files"][name])))
        for name in names
    ]
    path = dist / "release" / archive["name"]
    path.write_bytes(pack_archive(entries))
    archive.update(facts(path))
    sums = [f"{b['archive']['sha256']}  {b['archive']['name']}" for b in manifest["platforms"].values()]
    (dist / "release" / f"polaris-daemon-{manifest['version']}-SHA256SUMS").write_text(
        "\n".join(sums) + "\n"
    )


def read_manifest(dist: Path, version: str) -> dict:
    """The Daemon manifest, refused unless every name it gives is a plain file name."""
    manifest = read_json(dist / "manifest.json")
    if manifest.get("version") != version:
        raise SystemExit(f"Daemon manifest version {manifest.get('version')} is not {version}")
    for platform, build in manifest["platforms"].items():
        plain(platform, "Daemon platform")
        plain(build["binary"], f"{platform} binary")
        for name, entry in build["files"].items():
            plain(name, f"{platform} file")
            file_path(Path(platform), name, entry)
        if build.get("archive") is not None:
            plain(build["archive"]["name"], f"{platform} archive")
    return manifest


def helper_of(paths: dict, daemon: Path) -> Path:
    """The computer use helper app beside the Daemon's bundle, with its tools by its launcher."""
    if any(name not in paths for name in (HELPER_LAUNCHER, *HELPER_TOOLS)):
        raise SystemExit(f"missing {PLATFORM} computer use helper")
    helper = app_bundle_of(paths[HELPER_LAUNCHER])
    if helper != daemon.parent / HELPER_APP:
        raise SystemExit(f"{PLATFORM}: the computer use helper is not {HELPER_APP} beside the Daemon")
    for tool in HELPER_TOOLS:
        if paths[tool].parent != paths[HELPER_LAUNCHER].parent:
            raise SystemExit(f"{PLATFORM}: {tool} is not beside the helper's launcher")
    return helper


def bundle_libraries(paths: dict, bundle: Path) -> list:
    """The Daemon's native libraries: the manifest's files in its bundle's Frameworks (ENG-877)."""
    return sorted(path for path in paths.values() if path.parent == bundle / DAEMON_LIBRARIES)


def sign_daemon(signer: Signer, dist: Path, entitlements: Path, version: str) -> dict:
    manifest = read_manifest(dist, version)
    build = manifest["platforms"][PLATFORM]
    if build["binary"] != "polaris" or any(name not in build["files"] for name in DAEMON_ENTITLEMENTS):
        raise SystemExit(f"missing {PLATFORM} polaris or betterleaks")
    paths = {name: file_path(dist / PLATFORM, name, entry) for name, entry in build["files"].items()}
    for name, entry in build["files"].items():
        if facts(paths[name]) != {"sha256": entry["sha256"], "size": entry["size"]}:
            raise SystemExit(f"{PLATFORM}/{name}: bytes differ from the Daemon manifest")
    # Nested code first, then the app bundle, which seals it and signs the Daemon (ENG-680).
    bundle = app_bundle_of(paths["polaris"])
    helper = helper_of(paths, bundle)
    sign(signer, paths["betterleaks"], entitlements / DAEMON_ENTITLEMENTS["betterleaks"])
    # The Daemon has library validation: it loads only libraries signed by this team (ADR 0105).
    for library in bundle_libraries(paths, bundle):
        sign(signer, library, None)
    sign(signer, bundle, entitlements / DAEMON_ENTITLEMENTS["polaris"])
    run(["codesign", "--verify", "--deep", "--strict", bundle])
    # The helper's tools, then the bundle that seals them, under its own identity (ENG-846).
    for tool in HELPER_TOOLS:
        sign(signer, paths[tool], entitlements / HELPER_ENTITLEMENTS)
    sign(signer, helper, entitlements / HELPER_ENTITLEMENTS)
    run(["codesign", "--verify", "--deep", "--strict", helper])
    for name, entry in build["files"].items():
        entry.update(facts(paths[name]))
    build["sha256"] = build["files"]["polaris"]["sha256"]
    rewrite_archive(dist, manifest)
    write_json(dist / "manifest.json", manifest)
    return manifest


def restage_daemon(app: Path, dist: Path, manifest: dict) -> None:
    staged = app / "Contents/Resources/daemon"
    bundled = read_json(staged / "manifest.json").get("bundled")
    if bundled != [PLATFORM]:
        raise SystemExit(f"the app must bundle only {PLATFORM}'s Daemon, found {bundled}")
    for name, entry in manifest["platforms"][PLATFORM]["files"].items():
        source = file_path(dist / PLATFORM, name, entry)
        target = file_path(staged / PLATFORM, name, entry)
        make_dirs(staged, list(target.relative_to(staged).parts[:-1]))
        target.unlink(missing_ok=True)
        with open(target, "xb") as file:
            file.write(read_bytes(source))
        shutil.copystat(source, target, follow_symlinks=False)
    write_json(staged / "manifest.json", {**manifest, "bundled": bundled})


def is_macho(path: Path) -> bool:
    with path.open("rb") as file:
        head = file.read(8)
    # Java class files share the fat magic; their version field is far above any arch count.
    return head[:4] in MACHO or (head[:4] in FAT and int.from_bytes(head[4:8], "big") < 32)


def is_main_executable(path: Path) -> bool:
    """A bundle's own executable, which codesign signs when it signs the bundle."""
    grandparent = path.parent.parent
    if path.parent.name == "MacOS" and grandparent.name == "Contents" and grandparent.parent.suffix == ".app":
        info = grandparent / "Info.plist"
        return info.exists() and plistlib.loads(info.read_bytes()).get("CFBundleExecutable") == path.name
    # Name.framework/Versions/<version>/Name
    return grandparent.name == "Versions" and grandparent.parent.suffix == ".framework" and (
        path.name == grandparent.parent.stem
    )


def nested_code(app: Path) -> list:
    """Mach-O files and bundles inside the app, deepest first, without the signed Daemon."""
    daemon = app / "Contents/Resources/daemon"
    found = []
    for root, dirs, files in os.walk(app):
        here = Path(root)
        dirs[:] = sorted(d for d in dirs if here / d != daemon and not (here / d).is_symlink())
        found += [here / d for d in dirs if d.endswith((".app", ".framework"))]
        for name in sorted(files):
            path = here / name
            if not path.is_symlink() and is_macho(path) and not is_main_executable(path):
                found.append(path)
    return sorted(found, key=lambda path: len(path.parts), reverse=True)


def sign_app(signer: Signer, app: Path, entitlements: Path) -> None:
    for path in nested_code(app):
        sign(signer, path, entitlements)
    sign(signer, app, entitlements)
    run(["codesign", "--verify", "--deep", "--strict", app])


def write_sums(directory: Path) -> str:
    """assets.sha256 over every file in directory, as `shasum -a 256` writes; its own digest."""
    lines = [f"{facts(directory / name)['sha256']}  {name}" for name in sorted(os.listdir(directory))]
    sums = directory / "assets.sha256"
    sums.write_text("\n".join(lines) + "\n")
    return facts(sums)["sha256"]


def write_digests(out: Path, digests: dict) -> None:
    (out / "digests").write_text("".join(f"{key}={value}\n" for key, value in digests.items()))


def without_release(info: tarfile.TarInfo):
    return None if info.name == "dist/release" or info.name.startswith("dist/release/") else info


def write_handoff(tree: Path, out: Path, version: str) -> dict:
    """The signed bundle, the Daemon dist for Windows and the release assets; their digests."""
    dist = tree / DAEMON_DIST
    assets = out / "assets"
    assets.mkdir()
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", tree / APP,
         assets / f"Polaris-{version}-arm64-mac.zip"])
    for name in sorted(os.listdir(dist / "release")):
        (assets / plain(name, "Release asset")).write_bytes(read_bytes(dist / "release" / name))
    bundle = out / "release-bundle-signed.tar"
    with tarfile.open(bundle, "w") as tar:
        tar.add(dist, arcname=DAEMON_DIST)
        tar.add(tree / APP, arcname=APP)
    daemon = out / "polaris-daemon-dist.tar.gz"
    with tarfile.open(daemon, "w:gz") as tar:
        tar.add(dist, arcname="dist", filter=without_release)
    return {
        "bundle": facts(bundle)["sha256"],
        "daemon": facts(daemon)["sha256"],
        "assets": write_sums(assets),
    }


def release_app(signer: Signer, args) -> None:
    version = plain(args.version, "version")
    out = fresh_dir(args.out)
    tree = unpack_handoff(args.handoff, args.sha256, out / "tree")
    dist = tree / DAEMON_DIST
    app = tree / APP
    manifest = sign_daemon(signer, dist, args.entitlements, version)
    restage_daemon(app, dist, manifest)
    sign_app(signer, app, args.entitlements / APP_ENTITLEMENTS)
    if signer.notary is not None:
        submission = out / "notarise.zip"
        run(["ditto", "-c", "-k", "--keepParent", app, submission])
        notarize(signer, app, submission)
        submission.unlink()
    handoff = out / "handoff"
    handoff.mkdir()
    write_digests(out, write_handoff(tree, handoff, version))
    print(f"signed {app}\nhanded off {handoff}")


def release_dmg(signer: Signer, args) -> None:
    out = fresh_dir(args.out)
    assets = out / "assets"
    assets.mkdir()
    dmg = take_input(args.dmg, args.sha256, assets / plain(args.dmg.name, "installer image"))
    sign(signer, dmg, None, runtime=False)
    notarize(signer, dmg, dmg)
    run(["hdiutil", "verify", dmg])
    write_digests(out, {"assets": write_sums(assets)})
    print(f"signed {dmg}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--ad-hoc", action="store_true", help="sign with '-' and skip notarisation")
    commands = parser.add_subparsers(dest="command", required=True)
    app = commands.add_parser("app")
    app.add_argument("--handoff", type=Path, required=True)
    app.add_argument("--sha256", required=True)
    app.add_argument("--out", type=Path, required=True)
    app.add_argument("--entitlements", type=Path, required=True)
    app.add_argument("--version", required=True)
    dmg = commands.add_parser("dmg")
    dmg.add_argument("--dmg", type=Path, required=True)
    dmg.add_argument("--sha256", required=True)
    dmg.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("signing requires macOS")
    session = (
        contextlib.nullcontext(Signer("-", None, False, None))
        if args.ad_hoc
        else credentials(os.environ)
    )
    with session as signer:
        (release_app if args.command == "app" else release_dmg)(signer, args)


if __name__ == "__main__":
    main()
