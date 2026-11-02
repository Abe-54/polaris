import { afterAll, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectRpc, socketTransport } from "@polaris/client";
import { localEndpoint } from "@polaris/protocol/endpoint";
import {
  Command,
  CommandId,
  DomainEvent,
  HostStreamItem,
  LayerRun,
  ReviewerSettings,
  ReviewSubject,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  RiskSummaryRef,
  SessionId,
  SessionPlacement,
  SessionStreamItem,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { RESTART_NOTE } from "../reviewer/recovery.ts";
import { RULES_AFTER_TURN } from "../reviewer/run.ts";
import { EventStore } from "../store/EventStore.ts";
import { makeRepo, removeDir, tempDir } from "../git/testing.ts";

const dirs: Array<string> = [];

afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

test("Daemon startup does not import the Reviewer, the Usage index or the accept handlers", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(fileURLToPath(new URL("./serve.ts", import.meta.url)))});
     console.log(JSON.stringify(Object.keys(require.cache).map(path => path.replaceAll("\\\\", "/")).filter(path => /\\/apps\\/daemon\\/src\\/(reviewer|usage|accept)\\//.test(path))));`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const imported = Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(output));
  const names = imported.map((path) => path.split("/apps/daemon/src/")[1]);

  for (const heavy of [
    "reviewer/index.ts",
    "reviewer/run.ts",
    "reviewer/walkthrough.ts",
    "usage/UsageIndex.ts",
    "usage/db.ts",
    "usage/indexer.ts",
    "accept/AcceptRpcs.ts",
    "accept/draft.ts",
  ])
    expect(names).not.toContain(heavy);
});

/** The production Daemon on the scripted Harness, listening on a socket in a fresh home. */
const startDaemon = async (home = tempDir("polaris-lazy-home-")) => {
  dirs.push(home);
  const socket = localEndpoint(home);

  const daemon = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../main.ts"), "serve", "--foreground"],
    {
      env: {
        ...process.env,
        POLARIS_HOME: home,
        POLARIS_HOST_SOCKET: socket,
        POLARIS_BENCH_HARNESS: "1",
        // Usage reads no logs but these empty ones.
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
        POLARIS_SESSION_ID: undefined,
        POLARIS_BINARY: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const reader = daemon.stdout.getReader();
  let logs = "";

  while (!logs.includes("Daemon listening on")) {
    const chunk = await reader.read();

    if (chunk.done)
      throw new Error(`Daemon stopped: ${logs}\n${await new Response(daemon.stderr).text()}`);
    logs += new TextDecoder().decode(chunk.value);
  }

  reader.releaseLock();

  return { daemon, socket };
};

test("the first Usage, Reviewer and accept requests after start load and answer", async () => {
  const { daemon, socket } = await startDaemon();

  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* connectRpc(yield* socketTransport(socket));

          yield* client.hello({
            clientName: "lazy-test",
            clientVersion: "0",
            deviceLabel: "test",
            capabilities: ["usage", "review.reviewer-settings", "session.accept"],
          });

          const now = new Date().toISOString();

          const usage = yield* client["usage.query"]({
            from: new Date(Date.now() - 3_600_000).toISOString(),
            to: now,
            harness: null,
            sessionId: null,
          });

          yield* client["review.setReviewerSettings"]({
            settings: ReviewerSettings.make({ default: null, workspaces: {}, onSessions: false }),
          });

          const reviewer = yield* client["review.reviewerSettings"]({ workspaceId: null });

          const accept = yield* client["session.acceptPlan"]({
            sessionId: SessionId.make("no-such-session"),
            throughTurnId: null,
          }).pipe(Effect.flip);

          return { usage, reviewer, accept };
        })
      )
    );

    expect(result.usage.buckets).toEqual([]);
    expect(result.reviewer.settings.onSessions).toBe(false);
    expect(result.accept._tag).toBe("NotFound");
  } finally {
    daemon.kill();
    await daemon.exited;
  }
}, 60_000);

test("a Turn that changes files starts its Rules-only Risk Summary, loading the Reviewer", async () => {
  const repo = await makeRepo();
  dirs.push(repo);
  const { daemon, socket } = await startDaemon();
  const sessionId = SessionId.make("lazy-reviewer-session");
  let commands = 0;

  try {
    const summary = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* connectRpc(yield* socketTransport(socket));

          yield* client.hello({
            clientName: "lazy-test",
            clientVersion: "0",
            deviceLabel: "test",
            capabilities: ["review.risk-summary", "review.latest-summary"],
          });

          const dispatch = (command: Command) =>
            client.dispatch({ commandId: CommandId.make(`lazy-${++commands}`), command });

          yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: "lazy" }));

          const snapshot = yield* client
            .subscribeHost({ afterSequence: null })
            .pipe(Stream.filter(HostStreamItem.guards.Snapshot), Stream.runHead);

          const workspace = Option.getOrThrow(snapshot).workspaces.find((w) => w.name === "lazy");

          yield* dispatch(
            Command.cases.StartSession.make({
              sessionId,
              workspaceId: workspace!.id,
              harness: "codex",
              placement: SessionPlacement.cases.InPlace.make({}),
              permissionMode: "supervised",
              model: null,
              effort: null,
              prompt: `bench:${JSON.stringify({ items: 1, deltasPerItem: 0, touchFiles: 1 })}`,
              attachments: [],
            })
          );

          // The Turn's `after` checkpoint is the head its Risk Summary is cached under.
          const after = yield* client
            .subscribeSession({ sessionId, afterSequence: null, turnLimit: null })
            .pipe(
              Stream.flatMap((item) =>
                SessionStreamItem.guards.Event(item) &&
                DomainEvent.guards.CheckpointRecorded(item.envelope.event) &&
                item.envelope.event.ref.endsWith("/after")
                  ? Stream.make(item.envelope.event.commit)
                  : Stream.empty
              ),
              Stream.runHead,
              Effect.map(Option.getOrThrow)
            );

          const latest = client["review.riskSummary"]({
            ref: RiskSummaryRef.cases.LatestAt.make({ repo, head: after }),
          });

          return yield* latest.pipe(
            Effect.repeat({
              until: (found) => found !== null,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("20 seconds")
          );
        })
      )
    );

    expect(summary?.subject).toMatchObject({ sessionId });
    expect(summary?.layers.agent.note).toBe(RULES_AFTER_TURN);
  } finally {
    daemon.kill();
    await daemon.exited;
  }
}, 60_000);

test("a restart that left a Risk Summary running fails it on start, before any Reviewer request", async () => {
  const home = tempDir("polaris-lazy-home-");
  const summaryId = RiskSummaryId.make("rs_abandoned");

  const abandoned = RiskSummary.make({
    id: summaryId,
    key: RiskSummaryKey.make({ repo: "repo", mergeBase: "base", head: "head", since: null }),
    workspaceId: WorkspaceId.make("workspace"),
    subject: ReviewSubject.cases.SessionTurns.make({
      sessionId: SessionId.make("author"),
      firstTurnId: null,
      lastTurnId: null,
    }),
    checkoutId: null,
    status: "running",
    layers: RiskSummaryLayers.make({
      rules: LayerRun.make({ status: "running", note: null }),
      agent: LayerRun.make({ status: "pending", note: null }),
    }),
    reviewer: null,
    findings: [],
    cost: null,
    note: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([DomainEvent.cases.RiskSummaryStarted.make({ summary: abandoned })]),
      });
    }).pipe(Effect.provide(EventStore.layerSqlite(join(home, "state.sqlite"))))
  );

  const { daemon, socket } = await startDaemon(home);

  try {
    const recovered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* connectRpc(yield* socketTransport(socket));

          yield* client.hello({
            clientName: "lazy-test",
            clientVersion: "0",
            deviceLabel: "test",
            capabilities: ["review.risk-summary"],
          });

          return yield* client["review.riskSummary"]({
            ref: RiskSummaryRef.cases.ById.make({ summaryId }),
          });
        })
      )
    );

    expect(recovered).toMatchObject({ status: "failed", note: RESTART_NOTE });
  } finally {
    daemon.kill();
    await daemon.exited;
  }
}, 60_000);
