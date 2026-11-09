import { describe, expect, test } from "bun:test";
import type { HostConnection, LiveSession } from "@polaris/client";
import {
  HttpRequest,
  NotFound,
  RequestsError,
  RequestTarget,
  SendLookup,
  SessionId,
  Unsupported,
} from "@polaris/protocol";
import { Effect, Exit, Layer, Stream, SubscriptionRef } from "effect";
import type { HostView } from "../../shared/api.ts";
import { HostDirectory, UnknownHost } from "../hosts.ts";
import { httpRequestsHandlers, httpRequestsOpeners, toRequestsIpcError } from "./httpRequests.ts";

/** Every `requests.*` payload names its Agent Session; the fake checks it arrives unchanged. */
interface SessionScoped {
  readonly sessionId: SessionId;
}

interface Call {
  readonly tag: string;
  readonly payload: SessionScoped;
}

/** An IPC call, the RPC tag it should reach and the payload the Daemon should see. */
interface Row {
  readonly tag: string;
  readonly payload: SessionScoped;
  readonly call: () => Effect.Effect<unknown, unknown, HostDirectory>;
}

interface StreamRow {
  readonly tag: string;
  readonly open: () => Stream.Stream<unknown, unknown, HostDirectory>;
}

/** One Host whose session answers every RPC with its own tag and records the call. */
const directory = (capabilities: ReadonlyArray<string>, calls: Array<Call>) => {
  const client = new Proxy(
    {},
    {
      get: (_target, tag: string) => (payload: SessionScoped) => {
        calls.push({ tag, payload });

        return tag.endsWith("watch") ? Stream.make(tag) : Effect.succeed(tag);
      },
    }
  );

  const session = {
    capabilities,
    // SAFETY: the handlers call only the RPCs the proxy answers.
    client: client as LiveSession["client"],
  };

  return Layer.effect(
    HostDirectory,
    Effect.map(SubscriptionRef.make<ReadonlyArray<HostView>>([]), (views) =>
      HostDirectory.of({
        views,
        entry: () => undefined,
        connection: (key) => {
          if (key !== "studio") return Effect.fail(new UnknownHost(key));

          // SAFETY: the handlers read only `capabilities` and `client` of a session.
          const connection: Partial<HostConnection> = {
            session: Effect.succeed(session as LiveSession),
          };

          // SAFETY: the handlers read only `session` of a connection.
          return Effect.succeed(connection as HostConnection);
        },
        add: () => Effect.void,
        remove: () => Effect.void,
      })
    )
  );
};

const sessionId = SessionId.make("s-1");

const ref = { file: "http/invoices.http", name: "List overdue" };

const target = RequestTarget.cases.Saved.make({ ref });

const hostKey = "studio";

const save = {
  sessionId,
  request: new HttpRequest({ ...ref, method: "GET", url: "{{base}}/invoices", headers: [] }),
  previousName: "Old name",
};

const send = { sessionId, target, environment: "dev" };

const page = { sessionId, limit: 50 };

const get = { sessionId, lookup: SendLookup.cases.ById.make({ id: "send-1" }) };

const targeted = { sessionId, target };

const parse = { sessionId, text: "curl https://example.com" };

const h = httpRequestsHandlers;

const REQUESTS: ReadonlyArray<Row> = [
  { tag: "requests.save", payload: save, call: () => h["requests.save"]({ hostKey, ...save }) },
  { tag: "requests.send", payload: send, call: () => h["requests.send"]({ hostKey, ...send }) },
  {
    tag: "requests.variables",
    payload: targeted,
    call: () => h["requests.variables"]({ hostKey, ...targeted }),
  },
  {
    tag: "requests.sendLog.page",
    payload: page,
    call: () => h["requests.sendLog.page"]({ hostKey, ...page }),
  },
  {
    tag: "requests.send.get",
    payload: get,
    call: () => h["requests.send.get"]({ hostKey, ...get }),
  },
  {
    tag: "requests.curl.parse",
    payload: parse,
    call: () => h["requests.curl.parse"]({ hostKey, ...parse }),
  },
  {
    tag: "requests.curl.format",
    payload: targeted,
    call: () => h["requests.curl.format"]({ hostKey, ...targeted }),
  },
];

const STREAMS: ReadonlyArray<StreamRow> = [
  {
    tag: "requests.watch",
    open: () => httpRequestsOpeners["requests.watch"]({ hostKey, sessionId }),
  },
  {
    tag: "requests.sendLog.watch",
    open: () => httpRequestsOpeners["requests.sendLog.watch"]({ hostKey, sessionId }),
  },
];

describe("Requests over IPC", () => {
  for (const { tag, payload, call } of REQUESTS)
    test(`${tag} reaches the Daemon's RPC of the same tag without the Host`, async () => {
      const calls: Array<Call> = [];

      const answer = await Effect.runPromise(
        Effect.provide(call(), directory(["requests"], calls))
      );

      expect(answer).toBe(tag);
      expect(calls).toEqual([{ tag, payload }]);
    });

  for (const { tag, open } of STREAMS)
    test(`${tag} opens the Daemon's stream of the same tag`, async () => {
      const calls: Array<Call> = [];

      const items = await Effect.runPromise(
        Stream.runCollect(open()).pipe(Effect.provide(directory(["requests"], calls)))
      );

      expect([...items]).toEqual([tag]);
      expect(calls).toEqual([{ tag, payload: { sessionId } }]);
    });

  test("a Daemon without `requests` is never called and names the upgrade", async () => {
    const calls: Array<Call> = [];

    const exit = await Effect.runPromiseExit(
      Effect.provide(h["requests.send"]({ hostKey, ...send }), directory(["traces"], calls))
    );

    expect(calls).toEqual([]);
    expect(exit).toEqual(
      Exit.fail({ code: "Unsupported", message: "Requests need a newer daemon on this host" })
    );
  });
});

test("a RequestsError keeps its code and fix across IPC", () => {
  expect(
    toRequestsIpcError(
      new RequestsError({
        code: "E-VARIABLE-UNRESOLVED",
        message: "{{base}} has no value in dev",
        fix: "Add base to http-client.env.json",
      })
    )
  ).toEqual({
    code: "E-VARIABLE-UNRESOLVED",
    message: "{{base}} has no value in dev",
    fix: "Add base to http-client.env.json",
  });
  expect(toRequestsIpcError(new Unsupported({ capability: "requests" })).code).toBe("Unsupported");
  expect(toRequestsIpcError(new NotFound({ what: "Host", id: "offline" })).code).toBe("NotFound");
});
