# External binaries the Daemon installs

Each tool here follows the managed model server's pattern (`prediction/managed`, ADR 0049): a pin file with the upstream release, its commit and every platform's asset (URL, size, SHA-256 from the release's own digests), and `downloadFile` to fetch it size-bounded into `.part`, check the hash and rename it into place. It lives under `~/.polaris/tools/<tool>/<version>/`; a new pin installs beside the old version, then deletes it.

Nothing installs at start or on a timer, and nothing waits for an install. The first caller that finds the tool missing starts it in the background and goes on without it; later callers share that one download, Each attempt is cancelled after 10 minutes and retried twice, 5 s and 30 s apart; after that the next caller starts again. Once the pinned file is in place, a `stat` finds it, including after a restart. The idle Daemon pays nothing.

- `agentBrowser/`: vercel-labs/agent-browser (Apache-2.0), the Browser's MCP server (ADR 0092). Bare binaries for darwin arm64/x64, Linux arm64/x64 (glibc and musl) and Windows x64; no Chrome is downloaded, since it only attaches over CDP. It is not copied into Polaris, so ATTRIBUTION.md has no entry.
