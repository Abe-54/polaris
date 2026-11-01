# UF14: RP4 P9 fixes (ENG-659)

Cooperative profiling now uses a Worker's in-process `inspector.Session`, connected
to the main thread. It opens no TCP inspector. The Worker sends bounded profile
chunks over the private Unix socket; JSON parsing stays on the profile worker.
Real Node 24.22.1 tests use `lsof` while capturing busy JavaScript, during a native
block and after Daemon loss. A separate native-block test proves the capture
expires while the application stays alive. The registry also rejects profile
frames before capture acknowledgement; its malformed-completion regression
failed with a pending request before the guard and passes with the guard.

The sidebar click is user consent, with CPU sampling disclosed inline. Its RPC
works while idle and writes no ApprovalRequested event. Agent MCP captures still
require a fresh Allow once in their Turn. The paired-client socket test exercises
the real GrantGate: without Approve, both capture and RespondToApproval are
refused before their handlers execute. Same-user bare-socket authority remains
ENG-700; this change does not resolve that owner decision.

## Findings and regression evidence

The eight review repros failed on base 7044f9ce2 (0 pass, 8 fail). Their copies
were removed; the maintained tests are next to the implementation. The P9-6
assertion follows the Lead's user-consent decision instead of the review's
original suggestion to open a card while idle.

| Finding | Maintained regression | Negative control |
| --- | --- | --- |
| P9-1 | `traces/attach/regressions.test.ts`: busy JS, native block, Daemon loss, bounded timeout | Original TCP bootstrap makes the no-listener assertion fail. |
| P9-2 | `traces/attach/regressions.test.ts`: process.title changes | Restoring argv equality refuses the registered target. |
| P9-3 | `traces/attach/regressions.test.ts`: 1024 later environments; `lifecycle.test.ts`: archive retires tokens | Restoring FIFO eviction and global watchdog-token lookup makes capture fail. |
| P9-4 | `traces/attach/regressions.test.ts`: user Worker with nonce | Matching any nonce again loses the Worker's reply. |
| P9-5 | `traces/attach/regressions.test.ts`, `engine/session.test.ts`, `session.graph.test.ts` | Sending inspector approvals to Needs You again changes the terminal state. |
| P9-6 | `traces/attach/regressions.test.ts`: real user RPC while idle; `access.test.ts`: actual paired socket | Mapping the user RPC back to agent attach refuses the idle capture. |
| P9-7 | `traces/attach/regressions.test.ts`: MCP-approved capture leaves stderr empty | Publishing a debugger-listening line makes the stderr assertion fail. |
| P9-8 | `traces/attach/regressions.test.ts`: 255 other sockets | Restoring a shared 256-socket cap prevents capture. |
| P9-9 | `traces/attach/attach.test.ts`: a sibling with the same launch token cannot register the victim | Removing kernel peer-PID equality lets the forged registration stay connected. |
| P9-10 | Mobile requests/push/Live Activity tests, Raycast rows test, Daemon push plan/slice tests | Each test checks the attach-specific action/category against an ordinary approval. |

P9-1 through P9-9 negative controls ran individually in a temporary source copy,
restoring each file after its run. Each exited 1 with its targeted test failing;
none was an import/setup error. Native socket evidence is from macOS; Linux's
SO_PEERCRED branch has not been run on a Linux Host.

## State and ownership

In Terminal handles inspector and Data approvals without leaving that state.
Upgrade withdraws these Daemon-owned requests while leaving Harness approvals
and the terminal Turn alone. The graph now has 47 states / 285 transitions for
Claude and 55 / 377 for Codex. The Quint profile_attach model separates user
consent from agent approval and keeps `listening` false in every state.

Registration identity uses kernel peer PID, process start time, executable
inode/device, OS user and launch token. Argv is display-only. Launch capabilities
retire on their Agent Session's archive/failure event, even when unarchive is
committed in the same batch. The immediate-unarchive regression failed before
this event-based retirement and passes with it. Registration sockets and capture watchdogs have
separate caps; kernel peer PID reserves the watchdog lane. User Workers can enter
watchdog mode only with the bootstrap's token-named marker.

Changes outside the assigned paths are the MCP profile description and Daemon
push planning/slice modules and their tests. These remove the obsolete TCP risk
copy and prevent non-Desktop surfaces from offering remembered attach approval.

## Check limits

The first broad runs overlapped other workers and hit unrelated timeouts,
including a Mobile long-transcript test and an Engine fork/return-terminal path.
The first Desktop run hit sandbox listener restrictions; the unchanged native
rerun passed 344 tests. An early Daemon run also mixed module versions while the
raw profile transfer was being edited; its attach failures are superseded by the
stable-source rerun (49 attach and Session tests passed). Subsequent broad checks
run under the Lead's shared bench lease; final results belong in the Claim.
The final lifecycle and transfer tests pass (4 tests); the malformed-completion regression
failed before its fix. The sidebar retest passes (10 tests). Its first invocation
from the repository root missed the Desktop DOM preload; the package-local
invocation passed unchanged.
