# Auto-instrumentation (ENG-657)

`prepareAutoInstrumentation({checkout,cwd,settings,source,registerPath?,runtime?})`
returns `{environment,skipReason}`. `autoInstrumentationEnvironment` returns only
the environment patch. Call these only after Workspace Trust and checkout
ownership checks, with the injected receiver endpoint in `source`. The settings
owner records the read-only skip reason. No SDK runs inside the Daemon.

Off returns an empty patch. The local-copy switch does not disable the requested
instrumentation; a forwarder can still receive telemetry while local storage is off. Node prepends `--import <register URL>` to
existing `NODE_OPTIONS`; it reads manifests from the launch directory through the
checkout root, including development, optional and peer dependencies. An existing
`@opentelemetry/sdk-node`, `sdk-trace-*`, `sdk-trace` or `@vercel/otel` dependency suppresses the
preload unless `autoInstrumentOverride` is set. Unreadable, oversized or malformed
manifests also skip by default, because SDK ownership is unknown. The nearest package name becomes
`service.name`. Deno receives `OTEL_DENO=true`. A known Bun launch receives no
patch, and the register also refuses to initialize inside Bun. No `BUN_OPTIONS`
are changed.

`build.ts` bundles the pinned SDK and the ESM loader separately for Node, sharing
import-in-the-middle's registry file. `scripts/build-daemon.ts` embeds these as
data with a build plugin. On first opted-in launch, `assets.ts` materializes them
under a private content-addressed directory in the Daemon home. Existing apps can
keep their loader across Daemon upgrades. Development builds bundle lazily on
first use. The compiled Daemon does not need a checkout, npm, or node_modules to
materialize the register. Node itself remains a Host prerequisite.

The register enables HTTP, undici/fetch, pg, mysql2 and express instrumentation.
It configures both trace and log exporters with the Polaris endpoint, disables
metrics, bounds export time to one second and flushes finite commands on
`beforeExit`. Logs and traces share one HTTP connection because the receiver
admits one request per token. Setup and export failures do not crash the app;
telemetry is best effort when the endpoint is down. Explicit `process.exit` or a
forced process termination can lose pending telemetry. Signal handlers stay with
the app. Log records use the installed OTel API; this does not intercept console
output or install a logging framework.

`runtime.ts` composes the overlay after P1's collector preparation and signed
general/trace/log endpoint injection. Its captured services revalidate Workspace
Trust and writable Agent Session policy. Overrides never bypass those checks.
The same Trust layer is shared with the Engine in `transport/serve.ts`.
The launch directory resolves canonically within the containing checkout;
instrumentation assets are extracted under that runtime's own Daemon home.
SDK bundles are generated once lazily in development; extracted-path caches are
bounded to 32 homes. A compiled build uses its embedded data.

`../nodeOptions.ts` exports `appendNodeImport(options, path)` for P9 and other
bootstraps. It preserves other option bytes, quotes file URLs and avoids duplicate
absolute-path or file-URL imports, including `--import=value`. Instrumentation
places its new import first and preserves any existing bootstrap. P9 can append
the inspector bootstrap to that result. Internal `POLARIS_OTEL_ENDPOINT` and
`POLARIS_OTEL_SERVICE_NAME` must travel with the complete runtime overlay.

`detectFixedExporters({checkout,appRan,spansArrived})` returns PC's read-only
`DetectedTraceExporter[]`. Settings reads invoke it after observed application work,
not on a timer. It returns no evidence before a launch, after spans arrive, or
without an OTel dependency. Discovery uses safe git with standard ignore rules,
at most 256 KiB of filenames, 1,024 files, 64 KiB per regular file, 4 MiB of source
and 32 results. File reads reject symlinks, devices and paths outside the checkout.

Settings observe successful or background application commands from up to 16
recent Agent Sessions and their last two retained Turns, scoped to the checkout.
Direct terminal and Profile launches also record application-start evidence
after spawning. Merely requesting an environment is not evidence. Interactive
shell descendants without a command record are not inferred. A last-used
Worktree checkout is revalidated through `TraceSessions` before discovery.
Launch preparation reads settings without refreshing fixed-exporter discovery;
it records only skip reasons, preserving the detected vendor metadata.

This is conservative static evidence for a literal HTTP(S) `url` in an
`OTLPTraceExporter` or `OTLPExporter` constructor, not an evaluator. Aliases,
computed configuration, generated files and non-git directories are not inferred.
Comments, string examples, dynamic template URLs and existing endpoint fallbacks
are excluded. Evidence includes only checkout-relative file/line, with runtime
unknown; it never contains source or the collector URL. P10 can use
`fixedExporterChange` with file:line to ask for the research note's one-line fix:

```ts
url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl,
```

Preserve the existing URL as the fallback and retain the application's headers.
Absence of evidence is not proof that an application has no fixed exporter.

Run `bun test apps/daemon/src/traces/instrumentation` with native loopback access.
The tests launch a real Node ESM HTTP app making a fetch call, then read spans,
service name and correlated logs through the real receiver and SQLite store.
Other tests cover opt-in modes, hoisted SDK detection/override, endpoint failure,
compiled asset extraction, gitignore and bounded/symlink-safe discovery. The
runtime integration tests additionally run real Node and Bun terminal children.

After `bun scripts/build-daemon.ts darwin-arm64`, run the native built-binary smoke:

```sh
bun apps/daemon/src/main.ts lease bench -- bun apps/daemon/src/traces/instrumentation/packaged.smoke.ts apps/daemon/dist/darwin-arm64/polaris
```

It relocates the compiled executable, starts an isolated Daemon, registers a new
scratch Workspace, seeds only that disposable Workspace's Trust fixture, opts it
in through the real settings RPC and launches Node through the terminal RPC.
The smoke checks HTTP/fetch spans, package service naming and extraction from the
actual binary, then stops the Daemon and removes its files. It changes no live
Host Trust, installed Daemon or user Workspace.
