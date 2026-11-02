# Security findings index

Every finding from a security review, what fixed it on `main`, what keeps it fixed, and what is still open. The October 2026 Codex Security scan is summarised in [codex-2026-10.md](codex-2026-10.md).

A finding stays fixed through its tests (next to the code they cover) and, where new code could go around the fix, a **guard**: a lint rule or a repo-wide test that fails on the next bypass, not only the old call sites.

## Guards

| Guard | What it forbids | Allowlist | Negative test |
|---|---|---|---|
| `security/git-spawn` | starting git in the Daemon anywhere but `git/git.ts` (`Bun.spawn`, `child_process`, Bun's `$`, `which("git")`, `gitExecutable()`); an allowlisted safe-path user that stops calling `safeConfigEnv`; a bare `"git"` argv in an allowlisted file, which Windows looks up in the repository first (ADR 0069) | `packages/lint-config/plugins/security/allowlist.mjs` (`GIT_SPAWN`): the gate (`git.ts`, `executable.ts`, `safeConfig/index.ts`, `safeConfig/lazyFetch.ts`), safe-path users (`commitMessage/staged.ts`, `files/search/fallback.ts`, `rules/materialize.ts`, `rules/secrets/betterleaks.ts`), the user's `git commit` (`git/write.ts`) | `plugins/fixtures.test.ts`, fixtures `security/test/fixtures/daemon/` |
| `security/spawn-path` | in the Daemon: a spawn (`Bun.spawn`/`spawnSync`, `child_process`) whose program is a bare-name literal or a const holding one; a spawn with a `cwd` (or options the rule can't see into) whose program isn't `executableOf()` / `gitExecutable()` / `launchArgv()`, an absolute literal or `process.execPath`; `Bun.which` outside the resolver. Windows looks a bare name up in the cwd, a repository, before `PATH` (ADR 0070) | `SPAWN_PATH`: the resolver (`platform/executable.ts`), spawns resolved before the rule can see (`terminal/Terminals.ts`'s `programIn`, `constellation/setup/process.ts`'s `shellCommand`) | same, `fixtures/programs/` |
| `security/git-config-mode` | `config: "host"` or `"trusted-fetch"` outside git the user asked for | `GIT_CONFIG_MODE`: Accept's commit and push, `WorktreeTracker`, `constellationBundles`, `sync`, `write`, `review/fetch`, `review/remotes` | same, `fixtures/daemon/host-config.ts` |
| `security/image-decode` | `new Image`, `new ImageDecoder`, `createImageBitmap`, `URL.createObjectURL`, `.decode()`, `createElement("img")` and value imports of `mermaid` / `@streamdown/mermaid` in the renderer, `shared/` and `@polaris/ui` | `IMAGE_DECODE`: blobs `readHostImage` admitted (attachment previews, `SentAttachments`, `ImageViewer`), the editor's media pool (Main admitted), a file the user picked (`attachments/stage.ts`), Mermaid wrapped in `guardedDiagrams` (`plugins.ts`), the dev evidence pages | same, `fixtures/renderer/decodes.tsx` |
| `security/repository-env` | in the modules that start a repository's code (worktree setup, the Reviewer's env and confinement, the Rules layer's git and Betterleaks): `process.env` except through `repositoryEnv` / `setupEnv` / `readOnlyEnv`, any `childEnv`, a spawn without `env` | `REPOSITORY_ENV`: the scope list and the builders | same, `fixtures/setup/run.ts` |
| `no-restricted-globals` on `fetch` (`apps/desktop/.oxlintrc.json`) | a bare `fetch` in the Desktop App's Main: its internet goes through `internetFetch` (ADR 0053) | the override's `src/main/**` scope | `tooling/security/internetFetch.test.ts` |
| Actions pinned | an external GitHub Action (step, reusable workflow, composite action) by tag, branch or short SHA; a Docker image without a digest | local `./` actions | `tooling/security/actions.test.ts` |

The lint rules run in `bun run lint` and the pre-commit hook; the repo has no violations, so none are baselined. Adding an allowlist entry is a security decision: its comment says where the bytes, config or environment come from.

## Findings (Codex Security, October 2026)

Duplicates of one issue share a row. Fix commits are on `main`; merges in parentheses.

| Finding IDs | Severity | Title | Fix | Pinned by | Residual or owner action |
|---|---|---|---|---|---|
| `csf_9fcc70bf…`, `csf_3101076f…`, `csf_f6255697…`, `csf_c62207d8…` | high | Launching or dispatching a worker runs repository setup scripts before trust, with the Daemon's environment | `0b017e1e` (`ecce6b9c`) | `constellation/setup/setup.test.ts`, `setup/trust.test.ts`; `security/repository-env` | Trust is per Workspace on a Host, not per revision: once trusted, a new commit's setup runs. |
| `csf_b8889635…` | high | Opening a prepared workspace runs repository-local git commands | `017023ef`, `8f55df16`, `4a438cbd`, `edb87666`, `07842e3a` (`fd000002`, `dc354db0`, `7f86cb40`) | `git/safeConfig.slow.test.ts`, `safeConfig/lazyFetch.test.ts`, `rules/materialize.test.ts`, `rules/secrets/betterleaks.test.ts`, `git/review/fetch.slow.test.ts`, `review/worktree.slow.test.ts`; `security/git-spawn`, `security/git-config-mode` | `edb87666`/`07842e3a` close gaps found while writing the guards: a partial clone's lazy fetch ran a remote's `uploadpack`/`ext::` on any read (now `GIT_NO_LAZY_FETCH`, fail-closed below git 2.44), and the Rules' `cat-file` and Betterleaks' `git log` ran without the safe config. |
| `csf_641998208…` | high | Polaris-managed session and fork worktrees run repository git hooks | `e5c03536` (`fd000002`) | `git/WorktreeTracker.slow.test.ts`; `security/git-config-mode` | |
| `csf_1a24e9fd…` | medium | Opening an in-place session review runs an agent-authored git hook | `017023ef` (`fd000002`) | `git/safeConfig.slow.test.ts` (pinning Turns runs no hook) | |
| `csf_cfd95193…` | medium | Unbounded git output can exhaust the Daemon | `017023ef` (`fd000002`) | `git/safeConfig.slow.test.ts` (output limits); `security/git-spawn` | |
| `csf_78a9c661…`, `csf_66bf1f24…` | medium | Review Run exposes the Daemon's credentials to pull-request code | `2b7bda3d` (`9dca8c99`) | `terminal/TerminalRpcs.test.ts` | `Terminals.ts` starts both user and repository terminals, so the lint guard covers only its chooser (`terminal/environment.ts`); the RPC test pins the rest. |
| `csf_525f337d…` | medium | Pull-request content makes the Reviewer read files outside the checkout | `1d97b9ef`, `a086c9f0`, `af7a3221`, `cb08b0a2` (hook default-deny), `38c2d2da` (`9dca8c99`, `939d927f`) | `harness/claude/readOnly.test.ts`, `claude/sandbox.test.ts`, `harness/confinement.slow.test.ts`, `harness/confinedGit.test.ts`, `codex/reviewer.test.ts`, `readOnly.e2e.test.ts` (opt-in, the installed `claude`); `security/repository-env` | Toolchains under home don't run in the sandbox (product trade-off, ADR 0055). On Linux the checkout stays writable under bubblewrap. On macOS the Reviewer's shell can still read Claude Code's own provider key from its process arguments (`KERN_PROCARGS2`), a gap in Claude Code's sandbox to report upstream. ACP Reviewers are refused. |
| `csf_ad361ff0…` | medium | Opening repository Markdown exhausts renderer memory while decoding an image | `b56f77fe`, `021756fb`, `b0f0c457`, `2f6bfbf0`, `d6939365`, `5a993d8a` (`6296a6c6`, `a4ca8354`) | `shared/raster/raster.test.ts`, `budget.test.ts`, `avif.test.ts`, `editor/markdown/media.test.ts`, `host-images/index.test.ts`, `session/ui/markdown/diagrams.test.ts`; `security/image-decode` | JSX `<img src>` isn't checked: its URL must come from a guarded call site. The CSP (`img-src 'self' data: blob:`) keeps remote images out of every view. |
| `csf_31d63a73…` | medium | Clicking an agent-supplied path opens files outside the Workspace | `fb60e3ff` (`6296a6c6`) | `renderer/routes/editor.test.ts` | |
| `csf_796a1758…` | medium | Opening a large Workspace file exhausts the Daemon | `23eb09b7` (`6296a6c6`) | `daemon/src/files/write.test.ts`, `editor/files/bridge.test.ts` | |
| `csf_7272a547…` | medium | The Host's daemon archive download can fill its disk before verification | `fa953dcd` (`a69d682d`) | `packages/client/src/install/remote.test.ts` | |
| `csf_22cf9fc2…`, `csf_e82d1c44…`, `csf_4d3bd324…`, `csf_47f1f64b…`, `csf_80826cf5…` | medium, low | Download-email limits are per instance; distributed requests bypass them | `cefa08dd`, `0da58724`, `48970204`, `5b1fad9a` (`d58a5ce1`) | `apps/site/app/api/email/_lib/limiter.test.ts`, `email.test.ts` | Owner: the Upstash store is linked (2026-10-15); set `POLARIS_EMAIL_LIMIT_SECRET`, optionally add a Vercel Firewall rule on `/api/email`, and add CloudWatch alarms on SES send and validation volume, cost, bounces and complaints. Accepted (low): a catch-all domain or Fastmail subdomain addressing (`x@user.fastmail.com`) gets past the recipient cooldown; the source and total limits still apply. |
| `csf_9b9a39fb…` | medium | The download-email endpoint is an email-validity oracle | `cefa08dd` (`d58a5ce1`) | `email/_lib/events.test.ts` (every well-formed submission looks the same) | |
| `csf_5f27bdde…`, `csf_adedc3e4…`, `csf_e0e2213d…` | high | Mutable GitHub Action tags run with signing and publication authority | `f6f2cef2` (`54604247`) | `tooling/security/actions.test.ts` | Owner: the organisation's SHA-pinning policy, if wanted on top. |
| `csf_ba43617c…` | high | Repository-controlled release code runs with Apple signing credentials | `381d1e4a`, `f1158ae9` (`54604247`) | `tooling/release/workflows.test.ts`, `tooling/release/test_sign.py`, `apps/desktop/scripts/packaging/sign.slow.test.ts` | Owner: required reviewers on the `release` environment, branch protection and tag rules (ADR 0057). |
| `csf_45934ea6…` | low | A malformed review link crashes the renderer | `efd1f0ed` (`6296a6c6`) | `review/overview/model/overview.test.ts` | |
| `csf_61b10a84…` | low | A peer Host account can replace a verified daemon before remote install | `fa953dcd` (`a69d682d`) | `packages/client/src/install/remote.test.ts`, `daemon/src/service/install.test.ts` | |
| `csf_3ec81283…` | low | Plaintext Nucleo license credential in the checkout | none | none | Accepted, not a vulnerability, per the owner. |

## Regression fixtures

Adversarial probes written during the fixes, and where each lives now:

- GIF and animated WebP with a huge canvas and 1×1 frames, the preview pool admitting many of them, and a JPEG gain map: already covered by `shared/raster/budget.test.ts` and `editor/markdown/media.test.ts`.
- A YAML-escaped Mermaid `img` key: already covered by `session/ui/markdown/diagrams.test.ts`.
- IPv6 /48 rotation, mailbox spellings, IPv4-mapped IPv6: already covered by `limiter.test.ts`.
- A git proxy command and a remote `uploadpack`: already covered by `git/safeConfig.slow.test.ts`. The lazy-fetch variant is now `safeConfig/lazyFetch.test.ts` and `rules/materialize.test.ts`.
- The Reviewer reading `.git/config` through its file tools: already covered by `readOnly.test.ts` and `readOnly.e2e.test.ts`.
- Injection into the Reviewer's generated git config (a quote or backslash in a checkout path, a format value carrying a new section): `harness/confinedGit.test.ts` (new).
