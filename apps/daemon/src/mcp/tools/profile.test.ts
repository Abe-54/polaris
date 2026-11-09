import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Profile, ProfileId, Timestamp } from "@polaris/protocol";
import { LATE_ATTACH_LIMIT, Profiles } from "../../traces/profiles/index.ts";
import { cpuWork, withProfiles } from "../../traces/profiles/testing.ts";
import { TEST_SESSION, TRACE_ID, traceFixture, spanFixture } from "../../traces/testing.ts";
import { TraceSessions, TraceStore } from "../../traces/index.ts";
import { sessionProfileTools } from "../sessions/profiles.ts";
import { unavailableSessions } from "../sessions/index.ts";
import { profileTool, profileView } from "./profile.ts";
import { constellationTools } from "./index.ts";
import { fakeCommands } from "../testing.ts";
import { bindings } from "./data.testing.ts";

const text = (result: Awaited<ReturnType<ReturnType<typeof profileTool>["call"]>>) =>
  result.content[0]!.text;

test("profile is available on every binding with strict selectors and execution annotation", async () => {
  for (const binding of bindings) {
    const tool = constellationTools(binding, fakeCommands().commands).find(
      (t) => t.name === "profile"
    )!;

    expect(tool.annotations?.readOnlyHint).toBe(false);

    for (const input of [
      {},
      { command: ["bun"], process: 123 },
      { id: "x", waitSeconds: 1 },
      { command: [] },
      { process: 0 },
      { attach: 0 },
      { attach: 1, process: 1 },
      { attach: 1, seconds: 31 },
      { attach: 1, waitSeconds: 1 },
      { command: ["node"], seconds: 1 },
      { command: ["bun"], sessionId: "forged" },
    ])
      expect((await tool.call(input)).structuredContent?.code).toBe("E-INPUT");
    expect((await tool.call({ command: ["bun", "test"] })).structuredContent?.code).toBe(
      "E-PROFILE-UNAVAILABLE"
    );
  }
});

test(
  "MCP captures a real Bun command, reads its artifact and includes only checkout-scoped overlapping spans",
  () =>
    withProfiles(async ({ runtime }) => {
      const services = await runtime.runPromise(
        Effect.gen(function* () {
          const profiles = yield* Profiles;
          const sessions = yield* TraceSessions;
          const store = yield* TraceStore;

          return { profiles, sessions, store };
        })
      );

      const sessions = {
        ...unavailableSessions,
        profiles: sessionProfileTools(services.profiles, services.sessions, services.store),
      };

      const tool = profileTool(TEST_SESSION, sessions);
      const captured = await tool.call({ command: ["bun", "-e", cpuWork] });
      const profile = Schema.decodeUnknownSync(Profile)(captured.structuredContent?.profile);
      const detail = await runtime.runPromise(services.profiles.get(TEST_SESSION, profile.id));
      expect(detail.profile.status).toBe("completed");
      expect(text(captured)).toContain("Hot functions · self time");
      expect(text(captured)).toContain("Hot functions · total time");
      expect(text(captured)).toContain("Hot path");
      expect(text(captured)).toContain(detail.profile.path!);
      const context = await runtime.runPromise(services.sessions.session(TEST_SESSION));
      const start = BigInt(Date.parse(detail.profile.startedAt)) * 1_000_000n;
      const span = spanFixture({ start: start.toString() });

      const ingest = (checkout: string, traceId: string, time: bigint) =>
        runtime.runPromise(
          services.store.ingest({
            bytes: new TextEncoder().encode(
              JSON.stringify(
                traceFixture([
                  {
                    ...span,
                    traceId,
                    startTimeUnixNano: time.toString(),
                    endTimeUnixNano: (time + 1_000_000n).toString(),
                  },
                ])
              )
            ),
            signal: "traces",
            contentType: "application/json",
            context: { ...context, checkout },
          })
        );

      await ingest(context.checkout, TRACE_ID, start);
      await ingest("/elsewhere", "b".repeat(32), start);
      await ingest(context.checkout, "c".repeat(32), start - 1000_000_000n);

      const later =
        start + BigInt(Math.ceil(detail.profile.durationMs * 1_000_000)) + 1_000_000_000n;

      await runtime.runPromise(
        services.store.ingest({
          bytes: new TextEncoder().encode(
            JSON.stringify(
              traceFixture(
                Array.from({ length: 201 }, (_, i) => ({
                  ...span,
                  traceId: (i + 1).toString(16).padStart(32, "0"),
                  startTimeUnixNano: later.toString(),
                  endTimeUnixNano: (later + 1_000_000n).toString(),
                }))
              )
            )
          ),
          signal: "traces",
          contentType: "application/json",
          context,
        })
      );
      const read = await tool.call({ id: detail.profile.id });
      expect(read.structuredContent?.traces).toEqual([expect.objectContaining({ id: TRACE_ID })]);
      expect(read.structuredContent?.traceCount).toBe(1);
      expect(text(read)).toContain(TRACE_ID.slice(0, 8));
      expect((await tool.call({ process: process.pid })).structuredContent).toMatchObject({
        code: "E-PROFILE-PROCESS-NOT-OWNED",
        message: "Polaris didn't start this process",
      });
    }),
  60000
);

test("profile text ranks project locations first in each view, preserves function indices and stays below 16000 characters", () => {
  const profile = Profile.make({
    id: ProfileId.make("test"),
    command: "bun test",
    runtime: "bun",
    pid: 123,
    turn: null,
    startedAt: Timestamp.make(new Date().toISOString()),
    durationMs: 10,
    path: "/profiles/test.cpuprofile",
    status: "completed",
  });

  const hotFunctions = Array.from({ length: 100 }, (_, i) => ({
    name: `function ${i} ${"x".repeat(400)}`,
    file: i === 50 ? "src/work.ts" : "node:internal",
    line: 10,
    selfMs: 100 - i,
    totalMs: 100 - i,
  }));

  const detail = { profile, hotFunctions, hotPath: [0, 50], nodes: [] };
  const before = JSON.stringify(detail);
  const output = profileView(detail, { traces: [], total: 0 });
  expect(output.length).toBeLessThanOrEqual(16000);
  expect(output.indexOf("src/work.ts:10")).toBeLessThan(output.indexOf("node:internal:10"));
  expect(output).toContain("lines omitted");
  expect(output).toContain("Hot path");
  expect(output).toContain("Hot functions · total time");
  expect(output).toContain("Overlapping traces");
  expect(JSON.stringify(detail)).toBe(before);
});

test("P4-5: MCP profile summaries bound UTF-8 JSON, retain top frames and leave full detail on profiles.get", async () => {
  const profile = Profile.make({
    id: ProfileId.make("large"),
    command: "node server",
    runtime: "node",
    pid: 123,
    turn: null,
    startedAt: Timestamp.make(new Date().toISOString()),
    durationMs: 100,
    path: "/profiles/large.cpuprofile",
    status: "completed",
  });

  const hotFunctions = Array.from({ length: 200_000 }, (_, i) => ({
    name: `frame ${i} ${'😀\\"'.repeat(100)}`,
    file: "src/work.ts",
    line: i + 1,
    selfMs: 200_000 - i,
    totalMs: 200_000 - i,
  }));

  const detail = {
    profile,
    hotFunctions,
    hotPath: Array.from({ length: 256 }, (_, i) => i),
    nodes: Array.from({ length: 500_000 }, () => ({
      parent: null,
      functionIndex: 0,
      startMs: 0,
      durationMs: 1,
    })),
  };

  const tool = profileTool(TEST_SESSION, {
    ...unavailableSessions,
    profiles: {
      capture: () => Effect.succeed(profile),
      restart: () => Effect.succeed(profile),
      get: () => Effect.succeed(detail),
      overlapping: () => Effect.succeed({ traces: [], total: 0 }),
    },
  });

  for (const selector of [{ id: profile.id }, { command: ["node", "server"] }]) {
    const result = await tool.call(selector);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(16_000);
    expect(result.structuredContent).toMatchObject({
      functionCount: 200_000,
      nodeCount: 500_000,
    });

    const frames = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ index: Schema.Number, selfMs: Schema.Number }))
    )(result.structuredContent?.hotFunctions);

    expect(frames[0]).toEqual({ index: 0, selfMs: 200_000 });
    expect(result.structuredContent).not.toHaveProperty("nodes");
    expect(text(result)).toContain("Traces (⌘5)");
  }
});

test.each([
  ["attach", true],
  ["restart", false],
  ["command", false],
] as const)("an MCP profile made by %s names the late-attach limit: %p", (origin, noted) => {
  const profile = Profile.make({
    id: ProfileId.make("p1"),
    command: "node server.js",
    runtime: "node",
    pid: 42,
    turn: null,
    startedAt: Timestamp.make(new Date().toISOString()),
    durationMs: 5000,
    path: "/profiles/p1.cpuprofile",
    status: "completed",
    origin,
  });

  const output = profileView(
    { profile, hotFunctions: [], hotPath: [], nodes: [] },
    { traces: [], total: 0 }
  );

  expect(output.includes(LATE_ATTACH_LIMIT)).toBe(noted);
});
