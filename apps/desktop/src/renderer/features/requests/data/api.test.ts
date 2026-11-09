import { afterEach, expect, test } from "bun:test";
import { HttpRequest, RequestTarget, type RequestsSnapshot, SessionId } from "@polaris/protocol";
import { standInBridge } from "../../bridge.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { liveRequestsApi } from "./api.ts";

const at = { hostKey: "studio", sessionId: SessionId.make("s-1") };

const target = RequestTarget.cases.Saved.make({
  ref: { file: "http/invoices.http", name: "List overdue" },
});

const request = new HttpRequest({
  file: "http/invoices.http",
  name: "List overdue",
  method: "GET",
  url: "{{base}}/invoices/overdue",
  headers: [],
});

afterEach(() => standInBridge(null));

test("each call names the Host and session, and an environment only when one is picked", async () => {
  const bridge = installFakeBridge();

  await liveRequestsApi.send(at, { target, environment: "dev" });
  await liveRequestsApi.variables(at, { target, environment: null });
  await liveRequestsApi.formatCurl(at, { target, environment: "prod" });
  await liveRequestsApi.parseCurl(at, "curl https://example.com");

  expect(bridge.calls).toEqual([
    ["requests.send", { hostKey: "studio", sessionId: at.sessionId, target, environment: "dev" }],
    ["requests.variables", { hostKey: "studio", sessionId: at.sessionId, target }],
    [
      "requests.curl.format",
      { hostKey: "studio", sessionId: at.sessionId, target, environment: "prod" },
    ],
    [
      "requests.curl.parse",
      { hostKey: "studio", sessionId: at.sessionId, text: "curl https://example.com" },
    ],
  ]);
});

test("save renames only when the name changed", async () => {
  const bridge = installFakeBridge();

  await liveRequestsApi.save(at, request, "List overdue");
  await liveRequestsApi.save(at, request, "Overdue");
  await liveRequestsApi.save(at, request, null);

  expect(bridge.sent("requests.save").map((input) => input.previousName)).toEqual([
    undefined,
    "Overdue",
    undefined,
  ]);
});

test("the watch passes on the newest snapshot of each batch", () => {
  const bridge = installFakeBridge();
  const seen: Array<RequestsSnapshot> = [];

  liveRequestsApi.watch(at, { next: (s) => seen.push(s) });
  const feed = bridge.feeds("requests.watch")[0];

  expect(feed?.input).toEqual({ hostKey: "studio", sessionId: at.sessionId });
  feed?.listener.items([
    { files: [], environments: ["dev"] },
    { files: [], environments: ["dev", "prod"] },
  ]);
  expect(seen).toEqual([{ files: [], environments: ["dev", "prod"] }]);
});
