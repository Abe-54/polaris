/**
 * Drives a running Windows Daemon the way a Client does, over its named pipe:
 *
 *   bun apps/daemon/scripts/windows-smoke.ts <POLARIS_HOME> <git repo> [codex|claude]
 *
 * Under Node (`node apps/daemon/scripts/windows-smoke.ts …`) it connects as the Desktop App
 * does, checking the pipe's owner first (ADR 0062); Bun connects without that check.
 *
 * Asks `harness.availability`, `git.status` in the repo, then opens the default
 * shell and checks it echoes, resizes, and that closing it ends its process tree.
 * With a Harness, also lists its Models (Codex: through the shared app-server).
 * A Daemon still starting is waited for, up to 60 s, so CI can start one and run this at once.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { connectRpc, socketTransport } from "@polaris/client";
import { checksPipeOwner } from "../../../packages/client/src/transport.ts";
import { attachTerminal } from "../../../packages/client/src/terminal.ts";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { Effect, Predicate, Redacted, Schedule, Stream } from "effect";

const [home, repo, harness] = process.argv.slice(2);

if (home === undefined || repo === undefined) {
  console.error("usage: windows-smoke.ts <POLARIS_HOME> <git repo> [codex|claude]");
  process.exit(2);
}

const encode = (text: string) => new TextEncoder().encode(text);

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `: ${detail}`}`);

  if (!ok) process.exitCode = 1;
};

const program = Effect.gen(function* () {
  const pipe = localEndpoint(home);
  console.log(`pipe ${pipe}`);

  if (process.versions.bun === undefined)
    check("the Client checks the pipe's owner, as the Desktop App does", checksPipeOwner(pipe));

  const connection = yield* Effect.gen(function* () {
    return yield* connectRpc(yield* socketTransport(pipe));
  }).pipe(Effect.retry({ schedule: Schedule.spaced(250), times: 240 }));

  const { client } = connection;

  const hello = yield* client.hello({
    clientName: "windows-smoke",
    clientVersion: "0.2.0",
    deviceLabel: "smoke",
    capabilities: ["host.any-platform"],
    // As the Desktop App: the fresh home enrols it, so terminal.input is allowed (ADR 0100).
    userKey: Redacted.make("a".repeat(64)),
  });

  console.log(
    `host ${hello.host.platform} ${hello.host.daemonVersion}, protocol ${hello.protocolVersion}`
  );

  const harnesses = yield* client["harness.availability"]({ refresh: true });

  for (const entry of harnesses.harnesses)
    console.log(
      `harness ${entry.harness}: ${entry.status} ${entry.version ?? ""} ${entry.detail ?? ""}`
    );

  const status = yield* client["git.status"]({ cwd: repo });
  check("git.status", status.head !== null, `branch ${status.branch} head ${status.head}`);

  // ── Terminal: the default shell, in the repo.
  const { terminalId } = yield* client["terminal.open"]({
    cwd: repo,
    cols: 80,
    rows: 24,
    argv: null,
  });

  let text = "";
  const capabilities = hello.capabilities;

  yield* attachTerminal({ ...connection, capabilities }, terminalId).pipe(
    Stream.runForEach((item) =>
      Effect.sync(() => {
        text += Predicate.isTagged(item, "Output")
          ? new TextDecoder().decode(item.data)
          : `<exit ${item.code}>`;
      })
    ),
    Effect.forkScoped
  );

  const waitFor = (pattern: RegExp, ms = 20_000) =>
    Effect.promise(async () => {
      const deadline = Date.now() + ms;

      while (!pattern.test(text) && Date.now() < deadline) await sleep(50);

      return pattern.exec(text);
    });

  const input = (line: string) =>
    client["terminal.input"]({ terminalId, data: encode(`${line}\r`) });

  yield* input('echo "echo-$(40+2)"');
  check("terminal echoes", (yield* waitFor(/echo-42/)) !== null);

  yield* client["terminal.resize"]({ terminalId, cols: 131, rows: 37 });
  yield* input(
    'echo "size-$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)"'
  );
  check("terminal resizes", (yield* waitFor(/size-131x37/)) !== null);

  yield* input(
    "$p = Start-Process ping -ArgumentList '-n','600','127.0.0.1' -NoNewWindow -PassThru; echo \"pids-$PID-$($p.Id)-\""
  );
  const pids = yield* waitFor(/pids-(\d+)-(\d+)-/);
  const shell = Number(pids?.[1]);
  const child = Number(pids?.[2]);
  check(
    "shell and its child run",
    isRunning(shell) && isRunning(child),
    `shell ${shell}, ping ${child}`
  );

  yield* client["terminal.close"]({ terminalId });
  yield* waitFor(/<exit null>/, 5000);
  yield* Effect.sleep("500 millis");
  check(
    "closing ends the tree",
    !isRunning(shell) && !isRunning(child),
    `shell ${isRunning(shell)}, ping ${isRunning(child)}`
  );

  if (harness === "codex" || harness === "claude") {
    const models = yield* client["harness.models"]({ harness, refresh: true });
    check(
      `${harness} models`,
      models.models.length > 0,
      models.models
        .map((m) => m.id)
        .slice(0, 5)
        .join(", ")
    );
  }
});

await Effect.runPromise(Effect.scoped(program)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

process.exit();
