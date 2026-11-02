# Quarantining a flaky test

`tooling/test/quarantine.json` lists tests the required lane skips while their flake is fixed. The watchdog (`tooling/test/watchdog.ts`, behind every package's `test` script) prints each one it skips. The nightly (`.github/workflows/nightly.yml`) still runs them with `--quarantined`, on every OS, as a report.

## Adding an entry

1. Open an `ENG` issue for the flake, with the failing run.
2. Add an entry:

   ```json
   {
     "file": "apps/daemon/src/engine/engine.test.ts",
     "test": "Engine > a cancel reaches queued requests",
     "os": ["windows"],
     "issue": "ENG-123",
     "added": "2026-11-02"
   }
   ```

   - `file` is repo-relative, with forward slashes.
   - `test` is the full name as bun prints it in a `(fail)` line: the `describe` names and the test's, joined by ` > `. For `test.each`, use the name template, such as `row %p`; it quarantines every row.
   - `os` is `"all"` or a list of `windows`, `macos` and `linux`.
   - `added` is today's date.
3. Run `bun run lint`. It fails on an entry without an `ENG-` issue, an entry older than 30 days (about one release), or a file that no longer exists. When an entry expires, fix the test or delete it; don't bump the date.

Remove the entry in the change that fixes the test.

## Running them

- `bun run test -- --quarantined`, or `bun ../../tooling/test/watchdog.ts --quarantined` in a package, runs only the quarantined tests for this OS. A package with none passes at once.
- Matching wraps `test`, `it` and `describe` (with `.each`, `.if` and `.skipIf`) in a preload, `quarantinePreload.ts`. Only files with an entry for this OS are affected. Tests declared some other way, such as `test.serial`, can't be quarantined.
