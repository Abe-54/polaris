---
status: proposed (ENG-680)
---

# The macOS Daemon runs from an app bundle, carried as flat files

## Context

macOS names and draws a process from the `.app` bundle it runs in. A bare Mach-O such as
`~/.polaris/bin/<version>/polaris` shows as the generic exec icon with its file name in System
Settings (Privacy & Security prompts and panes, Login Items), so a user granting the Daemon
access to their files cannot tell what they are granting. TCC also keys a grant to the code's
designated requirement, which for a bundle is its identifier and Team ID.

## Decision

On macOS the Daemon is built into `PolarisDaemon.app` (`CFBundleIdentifier`
`dev.lux.polaris.daemon`, `CFBundleName` "Polaris", the Desktop App's icon, `LSUIElement` and
`LSBackgroundOnly`), with Betterleaks in `Contents/MacOS` beside it, and the whole bundle is
signed. `polaris install` and `polaris upgrade` stage it as `bin/<version>/PolarisDaemon.app`
and make `bin/<version>/polaris` a relative symlink to its executable, so `bin/current/polaris`,
launchd and every Client keep the one path they already use, and a rollback to an older flat
version still works. The launchd plist names the Desktop App in `AssociatedBundleIdentifiers` so
Login Items groups the agent under it.

Everything else carries the bundle as flat files: the manifest lists each file by name with its
`path` inside the platform directory, release archives and SSH uploads hold the files side by
side, and staging puts each back at its place. The bytes never change, so the signature stays
valid. The Client runs `upgrade` with the uploaded binary rather than the installed one, so the
build that knows the layout is the one that stages it, and a flat install becomes a bundle in a
single hand-off.

## Considered Options

- Keep the flat binary and set only an icon (`com.apple.ResourceFork`/Finder info): TCC and
  Login Items ignore it; neither has a bundle to read a name from.
- Symlinks inside the build (`bin/polaris` → bundle): release archives refuse paths and links,
  the release signer refuses links outside `Frameworks`, and the Desktop App's packager copies
  links as absolute paths into the build machine.
- Ship the bundle as a nested zip: a second archive format to verify and unpack on every Host,
  for the same bytes.

## Consequences

- A Developer ID build keeps one designated requirement across versions, so a TCC grant should
  survive upgrades; an ad-hoc dev build's requirement is its cdhash, so each one asks again.
- Linux and Windows builds are unchanged; a Linux Host given the bundle files installs flat.
