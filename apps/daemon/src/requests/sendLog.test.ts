import { expect, test } from "bun:test";
import { Send, SendLookup, type HttpMethod } from "@polaris/protocol";
import { SEND_LOG_LIMIT, SendLogFile } from "./sendLog.ts";

const send = (index: number, checkout = "/repo", method: HttpMethod = "GET") =>
  new Send({
    id: `send-${checkout}-${index}`,
    checkout,
    requestRef: null,
    method,
    url: `http://127.0.0.1:3000/orders/${index}`,
    requestHeaders: [],
    status: 200,
    responseHeaders: [],
    responseTruncated: false,
    durationMs: 1,
    traceId: index.toString(16).padStart(32, "0"),
    startedAt: new Date(index).toISOString(),
    by: { kind: "user" },
    outcome: "ok",
  });

test("the Send Log keeps each checkout's newest 1,000 Sends", () => {
  const log = SendLogFile.open(":memory:");
  const total = SEND_LOG_LIMIT + 5;

  for (let index = 1; index <= total; index++) log.put(send(index));
  log.put(send(1, "/other"));

  expect(log.count("/repo")).toBe(SEND_LOG_LIMIT);
  expect(log.count("/other")).toBe(1);
  expect(log.get("/repo", SendLookup.cases.ById.make({ id: "send-/repo-5" }))).toBeUndefined();
  expect(log.get("/repo", SendLookup.cases.ById.make({ id: "send-/repo-6" }))?.id).toBe(
    "send-/repo-6"
  );
  expect(log.page("/repo", { limit: 2 }).sends.map((item) => item.id)).toEqual([
    `send-/repo-${total}`,
    `send-/repo-${total - 1}`,
  ]);
});

test("pages walk newest first and the filter matches method and URL", () => {
  const log = SendLogFile.open(":memory:");

  for (let index = 1; index <= 5; index++)
    log.put(send(index, "/repo", index % 2 ? "POST" : "GET"));

  const first = log.page("/repo", { limit: 2 });
  const second = log.page("/repo", { limit: 2, before: first.next! });

  expect(second.sends.map((item) => item.id)).toEqual(["send-/repo-3", "send-/repo-2"]);
  expect(log.page("/repo", { filter: "post" }).sends.map((item) => item.id)).toEqual([
    "send-/repo-5",
    "send-/repo-3",
    "send-/repo-1",
  ]);
  expect(log.page("/repo", { filter: "orders/4" }).sends.map((item) => item.id)).toEqual([
    "send-/repo-4",
  ]);
  expect(log.get("/repo", SendLookup.cases.ByTrace.make({ traceId: send(2).traceId! }))?.id).toBe(
    "send-/repo-2"
  );
});
