# Developer Mode (ENG-709)

This Host's Developer Mode (CONTEXT.md; ADR 0095): whether Polaris traces itself here.

- `effective = stored || leases > 0 || fromSource`, and `DeveloperModeState.changes` streams it live.
- `stored` and the Polaris Workspace override live in `~/.polaris/developer-mode.json` (`storage.ts`).
- A lease counts while a `developerMode.lease` stream is open. Closing the stream or the connection releases it.
- The Polaris Workspace is the first git Workspace whose remote is github.com/luxdotdev/polaris (or lucasdoell/polaris), else one containing Polaris's root commit (`detect.ts`). `developerMode.setWorkspace` overrides it.

## Run from source

A Daemon run from source (not a compiled `polaris` binary) counts as `fromSource`, so it always traces. Set `POLARIS_DEVELOPER_MODE` when it starts to override that:

| Value | `fromSource` |
|---|---|
| `off` | false: test and bench Daemons, so they measure the off path |
| `on` | true, even in a compiled binary |
| unset or anything else | detected from the binary |

It is read once, when the Daemon starts. The stored setting and leases still apply either way.
