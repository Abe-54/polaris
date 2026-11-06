import { describe, expect, test } from "bun:test";
import {
  createEmit,
  errorInfo,
  withWideEvent,
  type Fetcher,
  type Level,
  type WideEvent,
} from "./index";

const env = {
  NODE_ENV: "production",
  VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123",
  VERCEL_DEPLOYMENT_ID: "dpl_test",
  VERCEL_ENV: "production",
  VERCEL_REGION: "iad1",
};

function harness() {
  const emitted: Array<{ event: WideEvent; level: Level }> = [];
  const tasks: Array<() => Promise<void>> = [];
  let clock = 1_000;

  const options = {
    env,
    now: () => (clock += 25),
    schedule: (task: () => Promise<void>) => {
      tasks.push(task);
    },
    emit: async (event: WideEvent, level: Level) => {
      emitted.push({ event, level });
    },
  };

  return { emitted, tasks, options, flush: () => Promise.all(tasks.map((task) => task())) };
}

describe("withWideEvent", () => {
  test("emits exactly one event per request with deployment context, status and timing", async () => {
    const h = harness();

    const handler = withWideEvent(
      "/api/thing",
      async (_, event) => {
        event.step = "done";

        return new Response(null, { status: 204 });
      },
      h.options
    );

    await handler(
      new Request("https://polaris.lux.dev/api/thing", { headers: { "x-vercel-id": "iad1::abc" } }),
      undefined
    );
    await h.flush();

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.level).toBe("info");
    expect(h.emitted[0]?.event).toMatchObject({
      request_id: "iad1::abc",
      method: "GET",
      route: "/api/thing",
      service: "polaris-site",
      commit: "0123456789ab",
      deployment_id: "dpl_test",
      environment: "production",
      region: "iad1",
      step: "done",
      status_code: 204,
      outcome: "success",
      duration_ms: 25,
    });
  });

  test.each([
    [422, "rejected", "info"],
    [503, "error", "error"],
  ])("status %i is %s at level %s", async (status, outcome, level) => {
    const h = harness();
    const handler = withWideEvent("/x", async () => new Response(null, { status }), h.options);

    await handler(new Request("https://polaris.lux.dev/x"), undefined);
    await h.flush();
    expect(h.emitted[0]).toMatchObject({ level, event: { status_code: status, outcome } });
  });

  test.each<[string, () => Promise<Level | void>, Level, string]>([
    ["finishes", async () => {}, "info", "success"],
    ["reports an error", async () => "error", "error", "error"],
    [
      "throws",
      async () => {
        throw new TypeError("private@example.com");
      },
      "error",
      "error",
    ],
  ])("background work that %s lands on the one event", async (_, finish, level, outcome) => {
    const h = harness();
    let released = false;

    const handler = withWideEvent(
      "/x",
      async (_request, event, _context, background) => {
        background(async () => {
          event.work = "done";
          released = true;

          return finish();
        });

        return new Response(null, { status: 202 });
      },
      h.options
    );

    await handler(new Request("https://polaris.lux.dev/x"), undefined);
    expect(released).toBe(false);
    await h.flush();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      level,
      event: { work: "done", status_code: 202, outcome },
    });
    expect(JSON.stringify(h.emitted)).not.toContain("private@example.com");
  });

  test("a thrown handler is recorded as a 500 with the error type but not its message", async () => {
    const h = harness();

    const handler = withWideEvent(
      "/x",
      async () => {
        throw new TypeError("private@example.com");
      },
      h.options
    );

    await Promise.resolve(
      expect(handler(new Request("https://polaris.lux.dev/x"), undefined)).rejects.toThrow(
        "private@example.com"
      )
    );
    await h.flush();
    expect(h.emitted[0]).toMatchObject({
      level: "error",
      event: { status_code: 500, outcome: "error", error: { type: "TypeError" } },
    });
    expect(JSON.stringify(h.emitted)).not.toContain("private@example.com");
  });
});

describe("errorInfo", () => {
  test("keeps an AWS error's name and HTTP status, never its message", () => {
    const error = Object.assign(new Error("Access denied for private@example.com"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403 },
    });

    expect(errorInfo(error)).toEqual({ type: "AccessDeniedException", http_status: 403 });
  });

  test("an unusual name or a non-error collapses to a generic type", () => {
    expect(errorInfo(Object.assign(new Error("x"), { name: "has spaces and @" }))).toEqual({
      type: "Error",
    });
    expect(errorInfo("private")).toEqual({ type: "unknown" });
  });
});

describe("emit", () => {
  const event = { route: "/x" };

  async function emitted(
    fetcher: Fetcher,
    emitEnv: Record<string, string | undefined> = {
      ...env,
      AXIOM_TOKEN: "t",
      AXIOM_DATASET: "polaris site",
    }
  ) {
    const lines: Array<{ level: Level; event: WideEvent }> = [];
    await createEmit(fetcher, (level, line) => lines.push({ level, event: line }))(
      event,
      "info",
      emitEnv
    );

    return lines;
  }

  const fetcher =
    (respond: () => Promise<Response>): Fetcher =>
    async () =>
      respond();

  test("ships to the dataset's Axiom edge domain (api.axiom.co answers 404), then writes one line with the ingest result", async () => {
    let url = "";

    const lines = await emitted(async (input) => {
      url = input;

      return Response.json({ ingested: 1, failed: 0 });
    });

    expect(url).toBe("https://us-east-1.aws.edge.axiom.co/v1/ingest/polaris%20site");
    expect(lines).toEqual([{ level: "info", event: { route: "/x", axiom: "ok" } }]);
  });

  test.each([
    [fetcher(async () => new Response("private", { status: 401 })), "rejected_401"],
    [fetcher(async () => Response.json({ ingested: 0, failed: 1 })), "rejected_receipt"],
    [fetcher(async () => Promise.reject(new TypeError("private"))), "failed_TypeError"],
  ])("records a failed ingest without its details %#", async (respond, axiom) => {
    const lines = await emitted(respond);

    expect(lines[0]?.event.axiom).toBe(axiom);
    expect(JSON.stringify(lines)).not.toContain("private");
  });

  test("unconfigured Axiom still writes the line", async () => {
    const lines = await emitted(
      fetcher(async () => Promise.reject(new Error("must not fetch"))),
      env
    );

    expect(lines[0]?.event.axiom).toBe("unconfigured");
  });
});
