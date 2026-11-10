/**
 * A scriptable stand-in for `opencode serve` v1: real HTTP and SSE on loopback,
 * basic auth, per-directory `/event` streams, and canned answers for the routes
 * the driver calls. Tests push events with `emit` and read what the driver sent
 * from `requests`.
 */
import { type PermissionMode, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { HarnessEvent, type HarnessSession } from "../../HarnessDriver.ts";
import { openSession } from "../OpenCodeSession.ts";
import type { Payload } from "../protocol.ts";
import type { OpenCodeServer } from "../Server.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly directory: string | null;
  readonly body: Payload;
}

type Handler = (request: RecordedRequest) => Payload;

export interface FakeServer {
  readonly url: string;
  readonly password: string;
  readonly requests: Array<RecordedRequest>;
  /** Sends one event to every `/event` stream open for `directory`. */
  readonly emit: (directory: string, payload: Payload) => void;
  /** Ends every open `/event` stream, as a server that went away would. */
  readonly dropEvents: () => void;
  /** Overrides a route, e.g. `respond("GET /session/status", () => ({ ses_1: { type: "busy" } }))`. */
  readonly respond: (route: string, handler: Handler) => void;
  /** Resolves once a `/event` stream is open for `directory`. */
  readonly subscribed: (directory: string) => Promise<void>;
  /** The requests to a route so far (`"POST /session/ses_1/prompt_async"`). */
  readonly sent: (route: string) => ReadonlyArray<RecordedRequest>;
  /** An `OpenCodeServer` whose lease hands out this fake. */
  readonly asServer: (passwordFile?: string) => OpenCodeServer;
  readonly stop: () => void;
}

export const FAKE_SESSION_ID = "ses_fake1";

const session = (
  id: string,
  directory: string,
  title = "New session - 2026-09-29T05:00:00.000Z"
) => ({
  id,
  slug: "fake",
  projectID: "global",
  directory,
  title,
  version: "1.18.33",
  time: { created: 0, updated: 0 },
});

export const makeFakeServer = (options: { readonly sessionId?: string } = {}): FakeServer => {
  const password = "fake-password";
  const sessionId = options.sessionId ?? FAKE_SESSION_ID;
  const requests: Array<RecordedRequest> = [];
  const streams = new Map<ReadableStreamDefaultController<Uint8Array>, string>();
  const waiters: Array<{ directory: string; resolve: () => void }> = [];
  const encoder = new TextEncoder();

  const routes = new Map<string, Handler>([
    ["POST /session", (r) => session(sessionId, r.directory ?? "/")],
    [`GET /session/${sessionId}`, (r) => session(sessionId, r.directory ?? "/")],
    [`PATCH /session/${sessionId}`, (r) => session(sessionId, r.directory ?? "/")],
    [`POST /session/${sessionId}/prompt_async`, () => null],
    [`POST /session/${sessionId}/abort`, () => true],
    [`POST /session/${sessionId}/summarize`, () => true],
    ["GET /session/status", () => ({})],
    ["GET /permission", () => []],
    ["GET /question", () => []],
    ["GET /config", () => ({})],
    ["GET /config/providers", () => ({ providers: [], default: {} })],
  ]);

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, payload: Payload) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  const eventStream = (directory: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.set(controller, directory);
          send(controller, { type: "server.connected", properties: {} });

          for (const waiter of waiters.splice(0))
            if (waiter.directory === directory) waiter.resolve();
            else waiters.push(waiter);
        },
        cancel: () => {
          for (const [controller, dir] of streams)
            if (dir === directory) streams.delete(controller);
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`)
        return new Response("unauthorized", { status: 401 });
      const url = new URL(req.url);
      const header = req.headers.get("x-opencode-directory");
      const directory = header === null ? null : decodeURIComponent(header);

      if (url.pathname === "/event") return eventStream(directory ?? "/");
      const text = await req.text();

      const body: Payload = text ? JSON.parse(text) : undefined;

      const recorded = {
        method: req.method,
        path: url.pathname,
        directory,
        body,
      };

      requests.push(recorded);
      const route = `${req.method} ${url.pathname}`;

      const handler =
        routes.get(route) ??
        (/^POST \/(permission|question)\/[^/]+\/(reply|reject)$/.test(route)
          ? () => true
          : undefined);

      if (handler === undefined) return new Response(`no fake route for ${route}`, { status: 404 });
      const result = handler(recorded);

      if (result instanceof Response) return result;

      return result === null ? new Response(null, { status: 204 }) : Response.json(result);
    },
  });

  const url = `http://127.0.0.1:${server.port}`;

  return {
    url,
    password,
    requests,
    emit: (directory, payload) => {
      for (const [controller, dir] of streams) if (dir === directory) send(controller, payload);
    },
    dropEvents: () => {
      for (const controller of streams.keys()) controller.close();
      streams.clear();
    },
    respond: (route, handler) => {
      routes.set(route, handler);
    },
    subscribed: (directory) =>
      [...streams.values()].includes(directory)
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ directory, resolve })),
    sent: (route) => requests.filter((r) => `${r.method} ${r.path}` === route),
    asServer: (passwordFile = "/nonexistent/opencode-server.password") => ({
      lease: Effect.succeed({ url, password, opencodePath: "/usr/local/bin/opencode" }),
      passwordFile,
      running: Effect.succeed(true),
    }),
    stop: () => {
      for (const controller of streams.keys()) controller.close();
      streams.clear();
      void server.stop(true);
    },
  };
};

// ---------------------------------------------------------------------------
// A session against the fake, recording its events

export type EventOf<T extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { readonly _tag: T }>;

export const ofTag = <T extends HarnessEvent["_tag"]>(
  events: ReadonlyArray<HarnessEvent>,
  tag: T
) => events.filter(HarnessEvent.$is(tag));

export const CWD = "/repo";

const cleanup: Array<() => void> = [];

/** Runs `fn` at the next `stopFakes`. */
export const onCleanup = (fn: () => void) => {
  cleanup.push(fn);
};

/** Stops every fake server `withSession` started; call it from `afterEach`. */
export const stopFakes = () => {
  for (const fn of cleanup.splice(0)) fn();
};

export interface Harness {
  readonly session: HarnessSession;
  readonly fake: FakeServer;
  readonly events: Array<HarnessEvent>;
  readonly emit: (...payloads: ReadonlyArray<unknown>) => void;
  /** The first event with `tag` (and matching `where`), waiting up to two seconds. */
  readonly waitFor: <T extends HarnessEvent["_tag"]>(
    tag: T,
    where?: (e: EventOf<T>) => boolean
  ) => Effect.Effect<EventOf<T>>;
}

export interface Options {
  readonly resumeCursor?: string;
  readonly permissionMode?: PermissionMode;
  readonly model?: string | null;
  readonly sessionId?: string;
  readonly setup?: (fake: FakeServer) => void;
}

/** Opens a session against a fake server and runs `body`; the scope closes afterwards. */
export const withSession = async <A>(
  body: (h: Harness) => Effect.Effect<A, unknown>,
  options: Options = {}
) => {
  const fake = makeFakeServer({ sessionId: options.sessionId ?? FAKE_SESSION_ID });
  cleanup.push(fake.stop);
  options.setup?.(fake);
  const events: Array<HarnessEvent> = [];

  const program = Effect.gen(function* () {
    const session = yield* openSession(
      fake.asServer("/home/user/.polaris/opencode-server.password"),
      {
        sessionId: SessionId.make("s1"),
        cwd: CWD,
        permissionMode: options.permissionMode ?? "supervised",
        model: options.model ?? null,
        effort: null,
        resumeCursor: options.resumeCursor ?? null,
      }
    );

    yield* session.events.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e))),
      Effect.forkDetach
    );

    const waitFor = <T extends HarnessEvent["_tag"]>(
      tag: T,
      where: (e: EventOf<T>) => boolean = () => true
    ) =>
      Effect.promise(async () => {
        for (let i = 0; i < 200; i++) {
          const found = ofTag(events, tag).find(where);

          if (found) return found;
          await Bun.sleep(10);
        }

        throw new Error(`timed out waiting for ${tag}; saw ${events.map((e) => e._tag).join(",")}`);
      });

    const emit = (...payloads: ReadonlyArray<unknown>) => {
      for (const payload of payloads) fake.emit(CWD, payload);
    };

    return yield* body({ session, fake, events, emit, waitFor });
  });

  const result = await Effect.runPromise(Effect.scoped(program));
  await Bun.sleep(20);

  return { result, events, fake };
};

export const turnInput = (
  turnId: string,
  prompt: string,
  model: string | null = null,
  effort: string | null = null
) => ({
  turnId: TurnId.make(turnId),
  prompt,
  attachments: [],
  model,
  effort,
});
