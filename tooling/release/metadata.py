"""Validate a release tag and the package versions for release.yml.

Reads RELEASE_TAG from the environment, checks apps/desktop and apps/daemon (under
--root, default the working directory) carry the tag's version, and appends version,
nuget_version and prerelease to $GITHUB_OUTPUT. Every release is signed; the sign job
fails without its secrets. Runs before dependencies are installed, so it uses only the stdlib.
"""

import argparse
import json
import os
import re
from pathlib import Path

NUMBER = r"(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"v({NUMBER}\.{NUMBER}\.{NUMBER})(?:-(alpha|beta|rc)\.({NUMBER}))?")


def metadata(tag: str, root: Path) -> dict:
    match = TAG.fullmatch(tag)
    if not match:
        raise SystemExit(
            "Expected v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<alpha|beta|rc>.N"
        )
    version = tag[1:]
    for package in ("desktop", "daemon"):
        actual = json.loads((root / "apps" / package / "package.json").read_text())["version"]
        if actual != version:
            raise SystemExit(f"Tag/version mismatch: {package} is {actual}, tag is {version}")

    prerelease = match.group(2) is not None
    # Squirrel's NuGet versions drop the prerelease dot (electron-winstaller convertVersion).
    nuget = f"{match.group(1)}-{match.group(2)}{match.group(3)}" if prerelease else version
    return {
        "version": version,
        "nuget_version": nuget,
        "prerelease": str(prerelease).lower(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    values = metadata(os.environ["RELEASE_TAG"], args.root)
    # Plain \n lines everywhere: on Windows text mode would write \r\n.
    with open(os.environ["GITHUB_OUTPUT"], "a", newline="\n") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))


if __name__ == "__main__":
    main()
