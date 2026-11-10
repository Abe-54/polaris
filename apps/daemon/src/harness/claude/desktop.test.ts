import { describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { Effect, Exit, Scope } from "effect";
import { agentBrowserServer, type BrowserMcp } from "../browser/index.ts";
import { DesktopMcp } from "../desktop/index.ts";
import { fakeDeps, fakeHost, fakeRunner } from "../desktop/testing.ts";
import type { OpenOptions } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude } from "./fakeClaude.ts";

const browser: BrowserMcp["Service"] = {
  forSession: (sessionId) =>
    Effect.succeed(agentBrowserServer("/opt/ab", sessionId, `/cfg/${sessionId}.json`)),
};

const desktopService = (ready = true) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* DesktopMcp;
    }).pipe(
      Effect.provide(
        DesktopMcp.layerWith(
          fakeDeps(fakeRunner({}).runner, { host: fakeHost({ ready: Effect.succeed(ready) }) })
        )
      )
    )
  );

const optionsOf = async (overrides: Partial<OpenOptions>, ready = true) => {
  const fake = new FakeClaude();

  const driver = makeClaudeDriver({
    query: fake.query,
    claudePath: () => "/opt/bin/claude",
    stagingDir: "/tmp/polaris-staging",
    browser,
    desktop: desktopService(ready),
  });

  const scope = Effect.runSync(Scope.make());

  await Effect.runPromise(
    driver
      .open({
        sessionId: SessionId.make("session-1"),
        cwd: "/work/repo",
        permissionMode: "supervised",
        model: null,
        effort: null,
        resumeCursor: null,
        ...overrides,
      })
      .pipe(Scope.provide(scope))
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  return fake.options!;
};

describe("polaris_desktop in Claude Code", () => {
  test("sits beside the Browser's server, with its tools pre-allowed", async () => {
    const o = await optionsOf({});

    expect(Object.keys(o.mcpServers ?? {}).toSorted()).toEqual([
      "polaris_browser",
      "polaris_desktop",
    ]);
    expect(o.allowedTools).toContain("mcp__polaris_desktop__*");
    // Plan mode takes exact names only: the tools that only look run there unasked.
    expect(o.allowedTools).toContain("mcp__polaris_desktop__snapshot");
    expect(o.allowedTools).not.toContain("mcp__polaris_desktop__type");
  });

  test("a read-only session and a Host that isn't ready get none", async () => {
    for (const [overrides, ready] of [
      [{ readOnly: true }, true],
      [{}, false],
    ] as const) {
      const o = await optionsOf(overrides, ready);

      expect(Object.keys(o.mcpServers ?? {})).not.toContain("polaris_desktop");
      expect(o.allowedTools ?? []).not.toContain("mcp__polaris_desktop__*");
    }
  });
});
