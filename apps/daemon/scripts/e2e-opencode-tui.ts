/**
 * Hands-on check of OpenCode live co-attach: the OpenCode driver and the real
 * `opencode attach` TUI in a PTY, on OpenCode Zen's free tier (no credentials;
 * the server and the TUI run with throwaway XDG directories):
 *
 *   POLARIS_E2E_OPENCODE_TUI=1 bun --cwd apps/daemon scripts/e2e-opencode-tui.ts
 *
 * 1. A supervised session takes one Turn from Polaris ("reply ready").
 * 2. The TUI starts in a PTY with the session's terminal command.
 * 3. A Turn typed into the TUI runs a command that needs approval. Polaris must
 *    see the Turn (with its prompt) and the approval; Polaris answers it; the
 *    command runs and the Turn ends completed.
 * 4. Closing the session stops the server.
 *
 * `POLARIS_OPENCODE` picks the binary (Zen's free tier needs OpenCode ≥ 1.18).
 * Evidence goes to `POLARIS_E2E_OUT` (default: a temp dir, printed at the end).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalDecision, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { HarnessEvent } from "../src/harness/HarnessDriver.ts";
import { scratchXdg } from "../src/harness/opencode/OpenCodeDriver.ts";
import { PlanLimitReporter } from "../src/harness/limits/PlanLimitReporter.ts";
import { HarnessRegistryLive } from "../src/harness/registry.ts";
import { BrowserMcp } from "../src/harness/browser/index.ts";
import { HarnessRegistry } from "../src/services.ts";

if (process.env.POLARIS_E2E_OPENCODE_TUI !== "1") {
  console.error("Starts OpenCode and its TUI; set POLARIS_E2E_OPENCODE_TUI=1 to run it.");
  process.exit(2);
}

const opencode = process.env.POLARIS_OPENCODE || Bun.which("opencode");

if (!opencode) {
  console.error("opencode not found; set POLARIS_OPENCODE");
  process.exit(2);
}

const t0 = Date.now();

const log = (...a: ReadonlyArray<unknown>) =>
  console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const root = mkdtempSync(join(tmpdir(), "polaris-opencode-tui-"));

const out = process.env.POLARIS_E2E_OUT ?? join(root, "out");

const repo = join(root, "repo");

mkdirSync(out, { recursive: true });

mkdirSync(repo);

await Bun.$`git init -q`.cwd(repo).quiet();

// The Daemon's registry, as `polaris serve` builds it, on a throwaway POLARIS_HOME.
Object.assign(process.env, scratchXdg(join(root, "xdg")), {
  POLARIS_HOME: join(root, "home"),
  POLARIS_OPENCODE: opencode,
});

const env = process.env;

const stateFile = join(root, "home", "opencode-server.json");

let tuiRaw = "";

const ESC = "\\u001b";

const BEL = "\\u0007";

const escapes = (pattern: string) => new RegExp(pattern, "g");

/** Strips escape sequences; cursor moves become newlines so words don't run together. */
const screenText = () =>
  tuiRaw
    .replace(escapes(`${ESC}\\[[0-9;?]*[Hf]`), "\n")
    .replace(escapes(`${ESC}\\[[0-9;?<>=]*[A-Za-z]`), "")
    .replace(escapes(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`), "")
    .replace(escapes(`${ESC}[()][A-Za-z0-9]`), "")
    .replace(/\r/g, "");

const results: Array<{ readonly check: string; readonly ok: boolean }> = [];

const check = (name: string, ok: boolean) => {
  results.push({ check: name, ok });
  log(ok ? "PASS" : "FAIL", name);
};

const until = async (what: string, condition: () => boolean, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      log(`timed out waiting for ${what}`);

      return false;
    }

    await Bun.sleep(100);
  }

  return true;
};

const events: Array<HarnessEvent> = [];

const eventsOf = <T extends HarnessEvent["_tag"]>(tag: T) => events.filter(HarnessEvent.$is(tag));

const program = Effect.gen(function* () {
  const registry = yield* HarnessRegistry;
  const driver = yield* registry.get("opencode");

  const session = yield* driver.open({
    sessionId: SessionId.make("tui"),
    cwd: repo,
    permissionMode: "supervised",
    model: "opencode/big-pickle",
    effort: null,
    resumeCursor: null,
  });

  yield* session.events.pipe(
    Stream.runForEach((e) => Effect.sync(() => events.push(e))),
    Effect.forkDetach
  );

  yield* session.sendTurn({
    turnId: TurnId.make("polaris-1"),
    prompt: "Reply with just the word ready. Do not run commands.",
    attachments: [],
    model: "opencode/big-pickle",
    effort: null,
  });
  yield* Effect.promise(() => until("first Turn", () => eventsOf("TurnEnded").length > 0, 120_000));
  check("Polaris Turn completes", eventsOf("TurnEnded")[0]?.status === "completed");

  const argv = yield* session.terminalCommand;
  log("TUI:", argv.join(" "));

  const tui = Bun.spawn([...argv], {
    cwd: repo,
    env: { ...env, TERM: "xterm-256color" },
    terminal: {
      cols: 120,
      rows: 40,
      data: (_t, data) => {
        tuiRaw += new TextDecoder().decode(data);
      },
    },
  });

  const type = (text: string) => tui.terminal?.write(text);

  yield* Effect.promise(() => until("TUI up", () => /ready/i.test(screenText()), 30_000));
  check("TUI shows the Polaris Turn's reply (same session)", /ready/i.test(screenText()));
  yield* Effect.sleep("2 seconds");

  type("Run exactly this shell command: touch tui-approval.txt ; then reply with the word done.");
  yield* Effect.sleep("500 millis");
  type("\r");
  log("typed a Turn into the TUI");

  yield* Effect.promise(() =>
    until("Polaris sees the TUI's Turn", () => eventsOf("TurnStarted").length > 0, 60_000)
  );
  check(
    "the TUI's Turn reaches Polaris with its prompt",
    eventsOf("TurnStarted")[0]?.prompt?.includes("tui-approval.txt") === true
  );

  yield* Effect.promise(() =>
    until("approval", () => eventsOf("ApprovalRequested").length > 0, 120_000)
  );
  const [approval] = eventsOf("ApprovalRequested");
  check("approval shows in Polaris", approval !== undefined);
  yield* Effect.sleep("1 second");
  writeFileSync(join(out, "tui-screen-at-approval.txt"), screenText());
  check("approval shows in the TUI", /permission|allow/i.test(screenText()));

  if (approval !== undefined) {
    yield* session.respond(
      approval.requestId,
      ApprovalDecision.cases.Allow.make({ remember: false })
    );
    log("answered the approval from Polaris");
  }

  yield* Effect.promise(() =>
    until("TUI Turn ends", () => eventsOf("TurnEnded").length > 1, 120_000)
  );
  const ended = eventsOf("TurnEnded")[1];
  check(
    "the TUI's Turn ends completed in Polaris",
    ended?.status === "completed" && ended.turnId === eventsOf("TurnStarted")[0]?.turnId
  );
  check("the approved command ran", existsSync(join(repo, "tui-approval.txt")));
  check(
    "Polaris recorded the approval once, never withdrawn",
    eventsOf("ApprovalRequested").length === 1 && eventsOf("ApprovalWithdrawn").length === 0
  );
  yield* Effect.sleep("1 second");
  writeFileSync(join(out, "tui-screen-final.txt"), screenText());

  tui.kill();
  yield* Effect.promise(() => tui.exited);
});

try {
  await Effect.runPromise(
    Effect.scoped(program).pipe(
      Effect.provide(
        HarnessRegistryLive.pipe(
          Layer.provide(Layer.mergeAll(PlanLimitReporter.none, BrowserMcp.none))
        )
      )
    )
  );
  check("the server stopped with the session", !existsSync(stateFile));
} finally {
  writeFileSync(join(out, "events.json"), JSON.stringify(events, null, 2));
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  log("evidence in", out);

  if (process.env.POLARIS_E2E_OUT === undefined) log("(temp dir kept for inspection)");
  else rmSync(root, { recursive: true, force: true });
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
