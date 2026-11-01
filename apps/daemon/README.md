# Daemon development startup

From a trusted Polaris checkout on macOS or Linux, invoke the shell launcher directly:

```sh
./scripts/daemon-dev.sh serve --foreground
./scripts/daemon-dev.sh --watch serve --foreground
./scripts/daemon-dev.sh version
```

It preserves the caller's working directory and launch environment, passes arguments
unchanged after the optional leading `--watch`, and replaces itself with Bun. Bun receives
`--no-env-file` and the launcher's explicit config before loading source, so cwd `.env`
files and `bunfig.toml` preloads cannot enter the trusted launch-source capture.
The installed Bun 1.4.4 `bun run --help` documents both flags. Bun's
[config fixture](https://github.com/oven-sh/bun/blob/bun-v1.4.4/test/config/bunfig/fixtures/preload/multi/readme.md)
documents that an explicit config replaces the default cwd bunfig.

The package scripts are also available, but the **outer Bun process** needs the same
flags. From the repository root:

```sh
bun --no-env-file --config=./scripts/daemon-dev.toml run daemon:dev
bun --no-env-file --config="$PWD/scripts/daemon-dev.toml" run --cwd apps/daemon dev
```

For Windows, or for other Bun runtime flags, use the explicit invocation from the
repository root (the shell launcher is not a native Windows entrypoint):

```sh
bun --no-env-file --config=./scripts/daemon-dev.toml --watch ./apps/daemon/src/main.ts serve --foreground
```

Direct `bun apps/daemon/src/main.ts`, its shebang/package bin, unflagged `bun run dev`
and `bun run daemon:dev` are not isolated startup entrypoints: Bun can read checkout
startup files before any application code runs. A wrapper cannot undo a parent's
preload side effects or distinguish already inherited dotenv values from intentional
launch variables. Desktop's source runner and benchmark/test helpers that invoke
`main.ts` directly have the same limitation. The caller must supply a trusted Bun,
launcher/config/source tree and parent environment; explicitly supplied runtime
preloads, `BUN_OPTIONS`, `NODE_OPTIONS` and shell startup files remain caller authority.

Compiled Daemons retain `autoloadDotenv: false` and `autoloadBunfig: false` in the build.
They do not need the source launcher. For real startup verification under `lease bench`,
see the [Traces smoke](src/traces/README.md).
