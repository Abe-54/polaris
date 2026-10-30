/**
 * The CDP relay end to end (ENG-616): the real agent-browser binary, the real relay, the real
 * `BrowserHosting` behind a real Daemon transport, real byte streams over the local socket to
 * a stand-in Desktop App in Electron (`apps/desktop/src/main/browserCdp/smoke/electronMain.ts`,
 * the real `serveBrowserHost` and facade over a real `WebContentsView`). Skipped without
 * Electron or `AGENT_BROWSER_BIN` (or `agent-browser` on PATH). `POLARIS_E2E_CLAUDE=1` adds a
 * real Claude Code session driving the tab through its `polaris_browser` MCP server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ApprovalDecision,
  ModelId,
  NO_DESKTOP_APP_MESSAGE,
  SessionId,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { BrowserMcp } from "../harness/browser/index.ts";
import { makeClaudeDriver } from "../harness/claude/ClaudeDriver.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { AgentBrowser } from "../install/agentBrowser/index.ts";
import { shortTemp } from "../platform/testing.ts";
import { cleanupHome, daemon, endpoint, freshHome } from "../transport/byteStreamsHarness.ts";
import { CdpRelay } from "./cdpRelay.ts";
import { BrowserHosting } from "./hosting.ts";

const repo = resolve(import.meta.dir, "../../../..");

const electron = join(repo, "apps/desktop/node_modules/.bin/electron");

const agentBrowser = process.env.AGENT_BROWSER_BIN ?? Bun.which("agent-browser");

const available = existsSync(electron) && agentBrowser !== null && process.env.CI === undefined;

const smoke = available ? test : test.skip;

const claudeSmoke = available && process.env.POLARIS_E2E_CLAUDE === "1" ? test : test.skip;

const claudeSession = SessionId.make("claude-e2e");

const mine = SessionId.make("mine");

const page = `<!doctype html><title>Smoke page</title><h1>Hello Polaris</h1>
<button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
<p id="out">idle</p>`;

let root = "";

let electronProcess: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;

let server: ReturnType<typeof Bun.serve> | null = null;

const scope = Effect.runSync(Scope.make());

let relay: CdpRelay["Service"];

const electronLog: Array<string> = [];

/** Tells the stand-in to connect to the Daemon and host `mine`'s Browser; idempotent. */
const hostDesktop = async () => {
  if (electronLog.includes("HOSTING") || electronProcess === null) return;
  void electronProcess.stdin.write("HOST\n");
  void electronProcess.stdin.flush();
  await until(() => electronLog.includes("HOSTING"), "the smoke Desktop to host");
};

const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let rest = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) return;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    lines.forEach(onLine);
  }
};

const until = async (condition: () => boolean, what: string, ms = 30_000) => {
  const deadline = Date.now() + ms;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

const run = async (args: ReadonlyArray<string>, session: string) => {
  const child = Bun.spawn([agentBrowser ?? "agent-browser", ...args], {
    cwd: root,
    env: { ...process.env, AGENT_BROWSER_SESSION: session, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
};

beforeAll(async () => {
  if (!available) return;
  root = mkdtempSync(shortTemp("polaris-cdp-smoke-"));
  freshHome();
  // A real Daemon transport with the byte-stream handlers; the relay shares its BrowserHosting.
  const { hosting } = await Effect.runPromise(daemon().pipe(Scope.provide(scope)));
  const bundle = join(root, "electronMain.mjs");

  const built = Bun.spawnSync(
    [
      "bun",
      "build",
      "apps/desktop/src/main/browserCdp/smoke/electronMain.ts",
      "--target=node",
      "--format=esm",
      "--external=electron",
      `--outfile=${bundle}`,
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" }
  );

  if (built.exitCode !== 0)
    throw new Error(`bundling the smoke Desktop failed: ${built.stderr.toString()}`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
  });
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
  electronProcess = Bun.spawn([electron, bundle, "--use-mock-keychain"], {
    cwd: root,
    env: {
      ...env,
      POLARIS_SMOKE_DAEMON_SOCKET: endpoint(),
      POLARIS_SMOKE_URL: `http://127.0.0.1:${server.port}/`,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void readLines(electronProcess.stdout, (line) => electronLog.push(line));
  void readLines(electronProcess.stderr, (line) => electronLog.push(`stderr: ${line}`));
  await until(() => electronLog.includes("READY"), "the smoke Desktop");
  relay = await Effect.runPromise(
    Layer.build(CdpRelay.layer({ home: root, version: "0.0.0-smoke" })).pipe(
      Effect.map((context) => Context.get(context, CdpRelay)),
      Effect.provide(Layer.succeed(BrowserHosting)(hosting)),
      Scope.provide(scope)
    )
  );
}, 120_000);

afterAll(async () => {
  if (!available) return;
  await run(["close"], "polaris-smoke-drive").catch(() => undefined);
  await run(["close"], `polaris-${claudeSession}`).catch(() => undefined);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await server?.stop(true);

  if (electronProcess !== null) {
    void electronProcess.stdin.end();
    const exited = await Promise.race([electronProcess.exited, Bun.sleep(5000).then(() => null)]);

    if (exited === null) electronProcess.kill();
  }

  rmSync(root, { recursive: true, force: true });
  cleanupHome();
}, 30_000);

smoke("a tab session's cookie methods reach only the tab's own partition (real Electron)", () => {
  const line = electronLog.find((entry) => entry.startsWith("COOKIES "));
  expect(line).toBeDefined();
  expect(JSON.parse(line?.slice("COOKIES ".length) ?? "{}")).toEqual({
    theirs: ["polaris"],
    mine: [],
    default: [],
    theirsAfterMineCleared: ["polaris"],
  });
});

// Runs before the stand-in hosts: no connection has registered with the Daemon yet.
smoke(
  "without a Desktop App, agent-browser fails with the product copy",
  async () => {
    expect(electronLog).not.toContain("HOSTING");
    const { url } = await Effect.runPromise(relay.issue(SessionId.make("unhosted")));
    const result = await run(["--cdp", url, "snapshot"], "polaris-smoke-unhosted");
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(NO_DESKTOP_APP_MESSAGE);
  },
  60_000
);

smoke(
  "agent-browser snapshots, clicks and screenshots the session's tab through the relay",
  async () => {
    await hostDesktop();
    const { url } = await Effect.runPromise(relay.issue(mine));
    const session = "polaris-smoke-drive";

    const snapshot = await run(["--cdp", url, "snapshot"], session);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toContain("Hello Polaris");
    const ref = /button "Go" \[ref=(e\d+)\]/.exec(snapshot.stdout)?.[1];
    expect(ref).toBeDefined();
    await until(
      () => electronLog.includes("DRIVING smoke-2 true"),
      "the agent-driving indicator",
      5000
    );

    const clicked = await run(["--cdp", url, "click", `@${ref}`], session);
    expect(clicked.exitCode).toBe(0);
    const text = await run(["--cdp", url, "get", "text", "#out"], session);
    expect(text.exitCode).toBe(0);
    expect(text.stdout.trim()).toBe("clicked");

    const file = join(root, "shot.png");
    const shot = await run(["--cdp", url, "screenshot", file], session);
    expect(shot.exitCode).toBe(0);
    const png = readFileSync(file);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.byteLength).toBeGreaterThan(1000);

    // The other session's tab (smoke-1) was never attached.
    expect(electronLog.some((line) => line.startsWith("DRIVING smoke-1 "))).toBe(false);
  },
  120_000
);

claudeSmoke(
  "a real Claude Code session drives the tab through its polaris_browser MCP server",
  async () => {
    await hostDesktop();

    const browser = await Effect.runPromise(
      Layer.build(BrowserMcp.layerAt(() => join(root, "browser-sessions"))).pipe(
        Effect.map((context) => Context.get(context, BrowserMcp)),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(CdpRelay)(relay),
            AgentBrowser.layerAt({ binary: agentBrowser ?? "agent-browser" })
          )
        ),
        Scope.provide(scope)
      )
    );

    const driver = makeClaudeDriver({ browser });
    const sessionScope = Effect.runSync(Scope.make());

    const session = await Effect.runPromise(
      driver
        .open({
          sessionId: claudeSession,
          cwd: mkdtempSync(join(root, "cwd-")),
          permissionMode: "supervised",
          model: ModelId.make("sonnet"),
          effort: null,
          resumeCursor: null,
        })
        .pipe(Scope.provide(sessionScope))
    );

    const events: Array<HarnessEvent> = [];
    const approved: Array<string> = [];

    const pump = Effect.runPromise(
      Stream.runForEach(session.events, (event) =>
        Effect.gen(function* () {
          events.push(event);

          if (!HarnessEvent.$is("ApprovalRequested")(event)) return;
          approved.push(event.title);
          yield* session
            .respond(event.requestId, ApprovalDecision.cases.Allow.make({ remember: false }))
            .pipe(Effect.ignore);
        })
      )
    );

    const page = `http://127.0.0.1:${server?.port ?? 0}/`;
    await Effect.runPromise(
      session.sendTurn({
        turnId: TurnId.make("t1"),
        prompt: `Use only the polaris_browser MCP tools and no other tools. Navigate to ${page} , take a snapshot, click the "Go" button using its ref from the snapshot, take another snapshot, and reply with exactly the text of the paragraph below the button and nothing else.`,
        attachments: [],
        model: null,
        effort: null,
      })
    );
    await until(() => events.some(HarnessEvent.$is("TurnEnded")), "the Turn", 200_000);
    expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({ status: "completed" });

    const text = events
      .filter(HarnessEvent.$is("ItemCompleted"))
      .flatMap(({ item }) => (TurnItem.guards.AssistantMessage(item) ? [item.text] : []))
      .join("");

    expect(text).toContain("clicked");
    expect(approved.join("\n")).toContain("polaris_browser");

    // The page itself, read through the same relay URL by another agent-browser session.
    const { url } = await Effect.runPromise(relay.issue(claudeSession));
    const check = await run(["--cdp", url, "get", "text", "#out"], "polaris-smoke-check");
    expect(check.stdout.trim()).toBe("clicked");
    await run(["close"], "polaris-smoke-check");

    await Effect.runPromise(Scope.close(sessionScope, Exit.void));
    await pump;
    console.log("claude e2e approvals:", approved.join(" | "), "| reply:", text);
  },
  300_000
);
