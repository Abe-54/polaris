import { afterEach, describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duration, Effect, Exit, Layer, Logger, ManagedRuntime, Scope } from "effect";
import { CdpRelay } from "../../browser/cdpRelay.ts";
import {
  AgentBrowser,
  type AgentBrowserInstaller,
  type InstallPolicy,
  type InstalledAgentBrowser,
} from "../../install/agentBrowser/index.ts";
import { BrowserMcp, type BrowserMcpServer } from "./index.ts";

const SESSION = SessionId.make("s1");

const URL = "ws://127.0.0.1:4100/browser/s1/s3cret-token";

const dirs: string[] = [];

const runtimes: Array<ManagedRuntime.ManagedRuntime<BrowserMcp, never>> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();

  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const relay = (issue: CdpRelay["Service"]["issue"]) =>
  Layer.succeed(CdpRelay)(CdpRelay.of({ issue, revoke: () => Effect.void }));

const relaying = relay(() => Effect.succeed({ url: URL }));

const harness = (
  relayLayer: Layer.Layer<CdpRelay>,
  installed: InstalledAgentBrowser | null = { binary: "/opt/ab" },
  installer?: AgentBrowserInstaller,
  policy: InstallPolicy = { attemptTimeoutMs: 5_000, retryDelaysMs: [] },
  setupTimeout: Duration.Input = "5 seconds"
) => {
  const dir = mkdtempSync(join(tmpdir(), "browser-mcp-"));
  dirs.push(dir);
  const logs: string[] = [];
  const logger = Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)));

  const runtime = ManagedRuntime.make(
    BrowserMcp.layerAt(() => join(dir, "sessions"), { setupTimeout }).pipe(
      Layer.provide(
        Layer.mergeAll(
          relayLayer,
          installer === undefined
            ? AgentBrowser.layerAt(installed)
            : AgentBrowser.layerWith(
                () => ({ root: "/nonexistent", platform: "test" }),
                installer,
                policy
              )
        )
      ),
      Layer.provideMerge(Logger.layer([logger]))
    )
  );

  runtimes.push(runtime);

  /** Opens the session's server in a scope the caller closes. */
  const open = async () => {
    const scope = Effect.runSync(Scope.make());

    const server = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* BrowserMcp).forSession(SESSION);
      }).pipe(Scope.provide(scope))
    );

    return { server, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  };

  return { open, logs, dir };
};

const configOf = (server: BrowserMcpServer | null) => server?.env["AGENT_BROWSER_CONFIG"] ?? "";

describe("BrowserMcp", () => {
  test("the relay URL reaches agent-browser through a private config file, never argv or env", async () => {
    const h = harness(relaying);
    const { server, close } = await h.open();

    expect(server?.command).toBe("/opt/ab");
    expect(server?.args).toEqual(["mcp", "--tools", "core"]);
    expect(server?.env).toMatchObject({
      AGENT_BROWSER_SESSION: "polaris-s1",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000",
    });
    expect(JSON.stringify(server)).not.toContain("s3cret-token");
    expect(await Bun.file(configOf(server)).json()).toEqual({ cdp: URL });
    expect(statSync(configOf(server)).mode & 0o777).toBe(0o600);
    await close();
    expect(existsSync(configOf(server))).toBe(false);
  });

  test("the config stays while another open of the session still holds it", async () => {
    const h = harness(relaying);
    const first = await h.open();
    const second = await h.open();

    await first.close();
    expect(existsSync(configOf(second.server))).toBe(true);
    await second.close();
    expect(existsSync(configOf(second.server))).toBe(false);
  });

  test("the relay stub's defect leaves the session without Browser tools instead of failing it", async () => {
    const h = harness(CdpRelay.layerStub);
    const { server } = await h.open();

    expect(server).toBeNull();
    expect(h.logs.join("\n")).toContain("session s1: no Browser tools");
    expect(existsSync(join(h.dir, "sessions"))).toBe(false);
  });

  test("a missing agent-browser leaves the session without Browser tools", async () => {
    const { server } = await harness(relaying, null).open();

    expect(server).toBeNull();
  });

  test("a relay error naming its URL is logged without the token", async () => {
    const h = harness(relay(() => Effect.die(new Error(`refused ${URL}`))));
    await h.open();

    expect(h.logs.join("\n")).toContain("/browser/s1/<redacted>");
    expect(h.logs.join("\n")).not.toContain("s3cret-token");
  });

  test("sessions share one background install and get the Browser once it lands", async () => {
    let installs = 0;
    let finish: (installed: InstalledAgentBrowser) => void = () => {};

    let installed: InstalledAgentBrowser | null = null;

    const h = harness(relaying, null, {
      onDisk: async () => installed,
      install: () => {
        installs += 1;

        return new Promise((resolve) => {
          finish = (done) => {
            installed = done;
            resolve(done);
          };
        });
      },
    });

    const [first, second] = await Promise.all([h.open(), h.open()]);

    expect([first.server, second.server]).toEqual([null, null]);
    expect(installs).toBe(1);
    expect(h.logs.join("\n")).toContain("later sessions get the Browser");
    finish({ binary: "/opt/ab" });
    await Bun.sleep(0);
    const third = await h.open();

    expect(third.server?.command).toBe("/opt/ab");
    expect(installs).toBe(1);
  });

  test("a failed install is reported and tried again by the next session", async () => {
    let installs = 0;

    const h = harness(relaying, null, {
      onDisk: async () => null,
      install: async () => {
        installs += 1;

        throw new Error("HTTP 503");
      },
    });

    await h.open();
    await Bun.sleep(0);
    const { server } = await h.open();

    expect(server).toBeNull();
    expect(installs).toBe(2);
    expect(h.logs.join("\n")).toContain("installing agent-browser failed (HTTP 503)");
  });

  test("a relay that never answers can't hold the session's open past the setup bound", async () => {
    const h = harness(
      relay(() => Effect.never),
      { binary: "/opt/ab" },
      undefined,
      undefined,
      "50 millis"
    );

    const { server } = await h.open();

    expect(server).toBeNull();
    expect(h.logs.join("\n")).toContain("setting up the Browser took too long");
  });

  test("a stalled download is cancelled and retried", async () => {
    const signals: AbortSignal[] = [];

    const h = harness(
      relaying,
      null,
      {
        onDisk: async () => null,
        install: (options) =>
          new Promise((_, reject) => {
            signals.push(options.signal!);
            options.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
          }),
      },
      { attemptTimeoutMs: 20, retryDelaysMs: [5] }
    );

    await h.open();

    while (signals.length < 2 || !signals[1]!.aborted) await Bun.sleep(5);
    await Bun.sleep(5);
    await h.open();

    expect(signals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
    expect(h.logs.join("\n")).toContain("installing agent-browser failed (timed out after 0 min)");
    expect(signals).toHaveLength(3);
  });
});
