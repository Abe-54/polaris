import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { makeClaudeDriver } from "../harness/claude/ClaudeDriver.ts";
import { FakeClaude } from "../harness/claude/fakeClaude.ts";
import { makeCodexDriver } from "../harness/codex/CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "../harness/codex/testing/session.ts";
import { Terminals, TerminalsLive, TerminalItem } from "../terminal/Terminals.ts";
import { TraceRuntime } from "./runtime.ts";
import { postTraces, TEST_SESSION, withTraceFixture } from "./testing.ts";

for (const readOnly of [false, true]) {
  test(`Claude ${readOnly ? "reviewer" : "agent"} receives a live endpoint, revoked at scope close`, () =>
    withTraceFixture(async (f) => {
      const fake = new FakeClaude();

      const driver = makeClaudeDriver({
        query: fake.query,
        claudePath: () => "/opt/bin/claude",
        sandbox: () => ({ available: true }),
      });

      let endpoint = "";
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* driver.open({
              sessionId: TEST_SESSION,
              cwd: f.root,
              permissionMode: "supervised",
              model: null,
              effort: null,
              resumeCursor: null,
              readOnly,
            });
            endpoint = fake.options?.env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
            expect(endpoint).toBe(f.endpoint!);

            if (readOnly) {
              expect(fake.options?.sandbox?.network?.allowedDomains).toEqual([]);
              expect(fake.options?.sandbox?.credentials?.envVars).not.toContainEqual({
                name: "OTEL_EXPORTER_OTLP_ENDPOINT",
                mode: "deny",
              });
            }

            expect((yield* Effect.promise(() => postTraces(endpoint))).status).toBe(200);
          }).pipe(Effect.provideService(TraceRuntime, f.runtime))
        )
      );
      expect((await postTraces(endpoint)).status).toBe(401);
    }));

  test(`Codex ${readOnly ? "reviewer" : "agent"} shell environment reaches the receiver`, () =>
    withTraceFixture(async (f) => {
      const withSession = sessionWith((options) =>
        makeCodexDriver(options).pipe(
          Effect.map((driver) => ({
            ...driver,
            open: (options) =>
              driver
                .open({ ...options, sessionId: TEST_SESSION, cwd: f.root })
                .pipe(Effect.provideService(TraceRuntime, f.runtime)),
          }))
        )
      );

      try {
        const result = await withSession(
          scripted(() => {}),
          () =>
            Effect.promise(async () => {
              expect((await postTraces(f.endpoint!)).status).toBe(200);
            }),
          { readOnly }
        );

        expect(result.server.requests("thread/start")[0]?.params).toMatchObject({
          config: {
            "shell_environment_policy.set": { OTEL_EXPORTER_OTLP_ENDPOINT: f.endpoint },
          },
        });
        expect((await postTraces(f.endpoint!)).status).toBe(401);
      } finally {
        for (const fn of cleanup.splice(0)) fn();
      }
    }));
}

test("terminals use a Workspace endpoint in both ordinary and repository environments", () =>
  withTraceFixture(async (f) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const terminals = yield* Terminals;

          for (const environment of ["user", "repository"] as const) {
            const terminal = yield* terminals.open({
              cwd: f.root,
              cols: 80,
              rows: 24,
              argv: ["/bin/sh", "-c", 'printf "%s" "$OTEL_EXPORTER_OTLP_ENDPOINT"'],
              environment,
            });

            const items = yield* terminals.attach(terminal).pipe(Stream.runCollect);

            const endpoint = items
              .filter(TerminalItem.guards.Output)
              .map((i) => new TextDecoder().decode(i.data))
              .join("");

            expect(endpoint).toMatch(new RegExp(`^http://127.0.0.1:${f.port}/otlp/[a-f0-9]{64}$`));
            expect(endpoint).not.toBe(f.endpoint!);
            expect((yield* Effect.promise(() => postTraces(endpoint))).status).toBe(200);
            yield* terminals.close(terminal);
          }
        }).pipe(Effect.provide(TerminalsLive), Effect.provideService(TraceRuntime, f.runtime))
      )
    );
  }));

test("a user exporter suppresses injection and marks the session as user-exported", () =>
  withTraceFixture(async (f) => {
    for (const key of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) {
      expect(
        await Effect.runPromise(
          f.runtime.environment(TEST_SESSION, { [key]: "https://collector.example" })
        )
      ).toEqual({});
      expect(await Effect.runPromise(f.runtime.setup(TEST_SESSION))).toMatchObject({
        endpoint: null,
        userExported: true,
      });
      expect(
        await Effect.runPromise(
          f.runtime.terminalEnvironment(f.root, { [key]: "https://collector.example" })
        )
      ).toEqual({});
    }
  }));
