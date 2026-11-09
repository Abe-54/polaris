// Requests RPCs through the real transport, handlers, send engine and files/ watcher (ENG-809).
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  DaemonRpcs,
  HttpRequest,
  RequestTarget,
  RequestsError,
  SendLookup,
  SessionId,
  type RequestsSnapshot,
} from "@polaris/protocol";
import { Effect, Layer, Queue, Stream } from "effect";
import { FileSearchLive } from "../files/FileSearch.ts";
import { tempDir } from "../platform/tempDir.testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import { TraceSessions } from "../traces/sessionsService.ts";
import { TraceStore } from "../traces/storeService.ts";
import { TEST_SESSION, withTraceFixture, type TraceFixture } from "../traces/testing.ts";
import { startServer } from "../transport/server.ts";
import { MASK } from "./format/index.ts";
import { NEW_REQUEST_FILE, requestsHandlers } from "./rpcs.ts";
import { closedPort, withServer } from "./sends.testing.ts";
import { RequestSends } from "./sendsService.ts";

const SECRET = "tok_live_51Hx9-ledger";

const files = (base: string, closed: number) => ({
  ".gitignore": ".env*\nhttp-client.private.env.json\n",
  ".env.local": `LEDGER_TOKEN=${SECRET}\n`,
  "http-client.env.json": JSON.stringify({
    dev: { base },
    staging: { base: `http://127.0.0.1:${closed}` },
    prod: { base: "https://ledger.example" },
  }),
  "api.http": [
    "### List invoices",
    "GET {{base}}/invoices",
    "Authorization: Bearer {{$dotenv LEDGER_TOKEN}}",
    "",
  ].join("\n"),
});

const checkoutWith = async (contents: Record<string, string>) => {
  const root = tempDir("rq-rpc-");

  for (const [file, text] of Object.entries(contents)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }

  Bun.spawnSync(["git", "init", "-q"], { cwd: root });

  return root;
};

/** A Daemon serving only the Requests handlers, and a connected Client that said hello. */
const connect = (fixture: TraceFixture, checkout: string) =>
  Effect.gen(function* () {
    const handlers = requestsHandlers(
      (sessionId) =>
        sessionId === TEST_SESSION
          ? Effect.succeed(checkout)
          : Effect.fail(
              new RequestsError({ code: "E-INPUT", message: "no session", fix: "pick one" })
            ),
      { settleMs: 20 }
    ).pipe(
      Layer.provide(RequestSends.layerAt(join(fixture.root, "requests.sqlite"))),
      Layer.provide(FileSearchLive({ useFff: false })),
      Layer.provide(Layer.succeed(TraceStore, fixture.store)),
      Layer.provide(Layer.succeed(TraceSessions, fixture.sessions))
    );

    const server = yield* startServer({
      root: fixture.root,
      socketPath: join(fixture.root, "d.sock"),
      lockPath: join(fixture.root, "d.lock"),
      handlers,
      capabilities: ["requests"],
      secrets: HostSecrets.memory(),
    });

    const { client } = yield* connectRpcWith(DaemonRpcs, yield* socketTransport(server.socketPath));

    const hello = yield* client.hello({
      clientName: "requests-test",
      clientVersion: "0",
      deviceLabel: "test",
      capabilities: [],
    });

    return { client, capabilities: hello.capabilities };
  });

/** Collects a stream's items into a queue in the background, for `next` to take one at a time. */
const follow = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    yield* Effect.forkScoped(Stream.runForEach(stream, (item) => Queue.offer(queue, item)));

    return Queue.take(queue).pipe(Effect.timeout("5 seconds"));
  });

const paths = (snapshot: RequestsSnapshot) =>
  snapshot.files.map((file) => [file.path, file.requests.map((request) => request.name)]);

const run = (body: (fixture: TraceFixture) => Effect.Effect<void, unknown, never>) =>
  withTraceFixture((fixture) => Effect.runPromise(body(fixture)));

test("the Desktop lists, saves, sends and pages the Send Log over RPC", () =>
  withServer(
    (request) =>
      new Response(`invoices for ${request.headers.get("authorization")}`, { status: 200 }),
    (base) =>
      run((fixture) =>
        Effect.scoped(
          Effect.gen(function* () {
            const checkout = yield* Effect.promise(async () =>
              checkoutWith(files(base, await closedPort()))
            );

            const { client, capabilities } = yield* connect(fixture, checkout);
            const sessionId = TEST_SESSION;

            expect(capabilities).toContain("requests");
            const next = yield* follow(client["requests.watch"]({ sessionId }));
            const first = yield* next;

            expect(paths(first)).toEqual([["api.http", ["List invoices"]]]);
            expect(first.environments).toEqual(["dev", "staging", "prod"]);

            const request = HttpRequest.make({
              file: NEW_REQUEST_FILE,
              name: "Health",
              method: "GET",
              url: "{{base}}/health",
              headers: [],
            });

            const saved = yield* client["requests.save"]({ sessionId, request });
            expect(saved.path).toBe(NEW_REQUEST_FILE);
            expect(saved.requests.map((item) => item.name)).toEqual(["Health"]);
            // The new file reaches the open watch through the files/ watcher.
            expect(paths(yield* next)).toEqual([
              ["api.http", ["List invoices"]],
              [NEW_REQUEST_FILE, ["Health"]],
            ]);

            const sent = yield* client["requests.send"]({
              sessionId,
              target: RequestTarget.cases.Saved.make({
                ref: { file: "api.http", name: "List invoices" },
              }),
              environment: "dev",
            });

            expect(sent).toMatchObject({
              outcome: "ok",
              status: 200,
              by: { kind: "user", sessionId },
              requestRef: { file: "api.http", name: "List invoices" },
            });
            expect(sent.responseBody).toBe(`invoices for Bearer ${MASK}`);
            expect(JSON.stringify(sent)).not.toContain(SECRET);

            const page = yield* client["requests.sendLog.page"]({ sessionId });
            expect(page.sends.map((item) => item.id)).toEqual([sent.id]);

            const byTrace = yield* client["requests.send.get"]({
              sessionId,
              lookup: SendLookup.cases.ByTrace.make({ traceId: sent.traceId! }),
            });

            expect(byTrace.id).toBe(sent.id);

            const log = yield* client["requests.sendLog.watch"]({ sessionId }).pipe(
              Stream.take(1),
              Stream.runCollect
            );

            expect(log[0]?.map((item) => item.id)).toEqual([sent.id]);
          })
        )
      )
  ));

test("VARIABLES shows each origin's locality and the .env file a $dotenv value came from", () =>
  run((fixture) =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* Effect.promise(async () =>
          checkoutWith(files("http://unused", await closedPort()))
        );

        const { client } = yield* connect(fixture, checkout);

        const target = RequestTarget.cases.Saved.make({
          ref: { file: "api.http", name: "List invoices" },
        });

        const variables = (environment: string) =>
          client["requests.variables"]({ sessionId: TEST_SESSION, target, environment });

        // Nothing listens on staging's loopback port: the Send can't leave the Host.
        const staging = yield* variables("staging");
        expect(staging[0]).toMatchObject({ name: "base", origin: "local" });
        expect(staging[1]).toEqual({
          name: "$dotenv LEDGER_TOKEN",
          source: "dotenv",
          masked: true,
          file: ".env.local",
        });
        expect((yield* variables("prod"))[0]).toMatchObject({ name: "base", origin: "remote" });
      })
    )
  ));

test("the watch re-emits when a gitignored env file adds an environment", () =>
  run((fixture) =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* Effect.promise(async () =>
          checkoutWith(files("http://unused", await closedPort()))
        );

        const { client } = yield* connect(fixture, checkout);
        const next = yield* follow(client["requests.watch"]({ sessionId: TEST_SESSION }));
        yield* next;

        yield* Effect.promise(() =>
          writeFile(
            join(checkout, "http-client.private.env.json"),
            JSON.stringify({ qa: { token: "x" } })
          )
        );

        expect((yield* next).environments).toContain("qa");
      })
    )
  ));

test("an unknown Agent Session is an input error", () =>
  run((fixture) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* connect(fixture, tempDir("rq-rpc-"));

        const error = yield* Effect.flip(
          client["requests.sendLog.page"]({ sessionId: SessionId.make("someone-else") })
        );

        expect(error).toBeInstanceOf(RequestsError);
        expect(error).toMatchObject({ code: "E-INPUT" });
      })
    )
  ));

test("save refuses a path outside the checkout and a file too large to edit", () =>
  run((fixture) =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* Effect.promise(() =>
          checkoutWith({ "big.http": `GET https://a.example/\n# ${"x".repeat(1024 * 1024)}\n` })
        );

        const { client } = yield* connect(fixture, checkout);

        const save = (file: string) =>
          Effect.flip(
            client["requests.save"]({
              sessionId: TEST_SESSION,
              request: HttpRequest.make({
                file,
                name: "Probe",
                method: "GET",
                url: "https://a.example/",
                headers: [],
              }),
            })
          );

        expect(yield* save("../escape.http")).toMatchObject({ code: "E-INPUT" });
        expect(yield* save("big.http")).toMatchObject({ code: "E-INPUT" });
        expect(
          (yield* Effect.promise(() => Bun.file(join(checkout, "big.http")).text())).length
        ).toBeGreaterThan(1024 * 1024);
      })
    )
  ));
