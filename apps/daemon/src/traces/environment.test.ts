import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { TraceTurn, TurnId } from "@polaris/protocol";
import { makeClaudeDriver } from "../harness/claude/ClaudeDriver.ts";
import { FakeClaude } from "../harness/claude/fakeClaude.ts";
import { makeCodexDriver } from "../harness/codex/CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "../harness/codex/testing/session.ts";
import { Terminals, TerminalsLive } from "../terminal/Terminals.ts";
import { TraceRuntime } from "./runtime.ts";
import { postTraces, TEST_SESSION, TRACE_ID, withTraceFixture } from "./testing.ts";

{
  const readOnly = false;

  test("Claude agent keeps its live endpoint after Harness retirement", () =>
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

            expect((yield* Effect.promise(() => postTraces(endpoint))).status).toBe(200);
          }).pipe(Effect.provideService(TraceRuntime, f.runtime))
        )
      );
      expect((await postTraces(endpoint)).status).toBe(200);
      f.state.active = false;
      expect((await postTraces(endpoint)).status).toBe(401);
    }));

  test("Codex agent shell environment reaches the receiver with unknown launch Turn", () =>
    withTraceFixture(async (f) => {
      const turn = TraceTurn.make({
        sessionId: TEST_SESSION,
        id: TurnId.make("codex-turn"),
        number: 5,
      });

      f.state.turns = [{ turn, start: "0", end: null }];

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
        expect((await postTraces(f.endpoint!)).status).toBe(200);
        const detail = await Effect.runPromise(f.store.get(f.root, TRACE_ID));
        expect(detail.spans[0]?.polaris).toMatchObject({ turn, launchedTurn: null });
        f.state.active = false;
        expect((await postTraces(f.endpoint!)).status).toBe(401);
      } finally {
        for (const fn of cleanup.splice(0)) fn();
      }
    }));
}

const otlpKeys = (env: Readonly<Record<string, string | undefined>> | undefined) =>
  Object.keys(env ?? {}).filter((key) => key.startsWith("OTEL_"));

const DAEMON_EXPORTER = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.axiom.co" };

test("a Claude Reviewer's session carries no OTLP endpoint, injected or inherited (ENG-676)", () =>
  withTraceFixture(
    async (f) => {
      const fake = new FakeClaude();

      const driver = makeClaudeDriver({
        query: fake.query,
        claudePath: () => "/opt/bin/claude",
        sandbox: () => ({ available: true }),
      });

      await Effect.runPromise(
        Effect.scoped(
          driver
            .open({
              sessionId: TEST_SESSION,
              cwd: f.root,
              permissionMode: "supervised",
              model: null,
              effort: null,
              resumeCursor: null,
              readOnly: true,
              environment: DAEMON_EXPORTER,
            })
            .pipe(Effect.provideService(TraceRuntime, f.runtime))
        )
      );

      expect(otlpKeys(fake.options?.env)).toEqual([]);
      expect(fake.options?.sandbox?.network?.allowedDomains).toEqual([]);
    },
    { readOnly: (id) => id === TEST_SESSION }
  ));

test("a Codex Reviewer's shell carries no OTLP endpoint (ENG-676)", () =>
  withTraceFixture(
    async (f) => {
      const withSession = sessionWith((options) =>
        makeCodexDriver(options).pipe(
          Effect.map((driver) => ({
            ...driver,
            open: (options) =>
              driver
                .open({
                  ...options,
                  sessionId: TEST_SESSION,
                  cwd: f.root,
                  environment: DAEMON_EXPORTER,
                })
                .pipe(Effect.provideService(TraceRuntime, f.runtime)),
          }))
        )
      );

      try {
        const result = await withSession(
          scripted(() => {}),
          () => Effect.void,
          { readOnly: true }
        );

        const params = result.server.requests("thread/start")[0]?.params;

        expect(params).toMatchObject({ config: { "shell_environment_policy.inherit": "core" } });
        expect(JSON.stringify(params)).not.toContain("OTEL_");
      } finally {
        for (const fn of cleanup.splice(0)) fn();
      }
    },
    { readOnly: (id) => id === TEST_SESSION }
  ));

test("terminals use a Workspace endpoint in both ordinary and repository environments", () =>
  withTraceFixture(async (f) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const terminals = yield* Terminals;

          for (const environment of ["user", "repository"] as const) {
            const captured = join(f.root, `terminal-${environment}.txt`);

            const terminal = yield* terminals.open({
              cwd: f.root,
              cols: 80,
              rows: 24,
              argv: [
                process.execPath,
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(captured)}, process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "")`,
              ],
              environment,
            });

            yield* terminals.attach(terminal).pipe(Stream.runDrain);
            const endpoint = yield* Effect.promise(() => readFile(captured, "utf8"));

            expect(endpoint).toMatch(
              new RegExp(`^http://127.0.0.1:${f.port}/otlp/[a-f0-9]{64}\\.`)
            );
            expect(endpoint).not.toBe(f.endpoint!);
            expect((yield* Effect.promise(() => postTraces(endpoint))).status).toBe(200);
            yield* terminals.close(terminal);
          }
        }).pipe(Effect.provide(TerminalsLive), Effect.provideService(TraceRuntime, f.runtime))
      )
    );
  }));

test("an existing exporter no longer suppresses injection or marks setup as user-exported", () =>
  withTraceFixture(async (f) => {
    for (const key of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) {
      expect(
        await Effect.runPromise(
          f.runtime.environment(TEST_SESSION, { [key]: "https://collector.example" })
        )
      ).toMatchObject({
        OTEL_EXPORTER_OTLP_ENDPOINT: f.endpoint,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${f.endpoint}/v1/traces`,
      });
      expect(await Effect.runPromise(f.runtime.setup(TEST_SESSION))).toMatchObject({
        endpoint: f.endpoint,
        userExported: false,
      });
      expect(
        await Effect.runPromise(
          f.runtime.terminalEnvironment(f.root, { [key]: "https://collector.example" })
        )
      ).toHaveProperty("OTEL_EXPORTER_OTLP_ENDPOINT");
    }
  }));

test("a Reviewer's session gets no OTLP endpoint while others still do (ENG-676)", () =>
  withTraceFixture(
    async (f) => {
      expect(f.endpoint).toBeNull();
      expect(
        await Effect.runPromise(
          f.runtime.environment(TEST_SESSION, {
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
          })
        )
      ).toEqual({});
    },
    { readOnly: (id) => id === TEST_SESSION }
  ));
