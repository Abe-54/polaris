/** "Resend in Requests ⌘6" in the trace bar, only on a trace a Send started (Paper Q3; ENG-809). */
import { REQUESTS_CAPABILITY, Send, SessionId, type TraceDetail, TraceId } from "@polaris/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { RequestsApi } from "../../requests/data/api.ts";
import { RequestsLayer } from "../../requests/data/hooks.tsx";
import { clearRequestsView, requestsView } from "../../requests/model/store.ts";
import { fixtureRequestsApi } from "../../requests/preview/fixtureApi.ts";
import { publishOpenTrace } from "../model/openTrace.ts";
import { FIXTURE_DETAILS, FIXTURE_SESSION } from "../preview/fixtures.ts";
import { HOST, providers, scripted } from "./mode.testing.tsx";
import { TraceBar } from "./TraceBar.tsx";

// Its own session: other files' tests share these module stores when bun interleaves them.
const AT = { hostKey: HOST, sessionId: SessionId.make("s-trace-bar") };

afterEach(() => {
  cleanup();
  act(() => {
    publishOpenTrace(AT, null);
    clearRequestsView(AT);
  });
});

const BASE = FIXTURE_DETAILS[0]!;

const traceOf = (service: string): TraceDetail => ({
  ...BASE,
  summary: { ...BASE.summary, service },
});

const sendFor = (detail: TraceDetail, ref: Send["requestRef"]) =>
  new Send({
    id: "send-7",
    checkout: "/Users/lucas/code/ledger",
    requestRef: ref,
    environment: "staging",
    method: "POST",
    url: "http://localhost:4000/invoices/recalculate",
    requestHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "traceparent", value: `00-${detail.summary.id}-a1b2c3d4e5f60718-01` },
    ],
    requestBody: '{ "overdue": true }',
    status: 200,
    responseHeaders: [],
    responseTruncated: false,
    durationMs: 120,
    traceId: TraceId.make(detail.summary.id),
    startedAt: "2026-11-09T14:02:11.000Z",
    by: { kind: "user", sessionId: FIXTURE_SESSION },
    outcome: "ok",
  });

/** The bar over `detail`, with the Requests calls counted; `capable` is the Host's `requests`. */
const mount = (detail: TraceDetail, sends: ReadonlyArray<Send>, capable = true) => {
  const fake = scripted(() => [detail]);
  const { store, navigation, wrapper: Wrapper } = providers(fake.api);
  const base = fixtureRequestsApi({ sends });
  const lookups: Array<string> = [];

  const api: RequestsApi = {
    ...base,
    getSend: (at, lookup) => {
      lookups.push(JSON.stringify(lookup));

      return base.getSend(at, lookup);
    },
  };

  if (!capable)
    store.setState((s) => ({
      hosts: s.hosts.map((h) => ({
        ...h,
        status: {
          ...h.status,
          capabilities: h.status.capabilities.filter((c) => c !== REQUESTS_CAPABILITY),
        },
      })),
    }));
  act(() => publishOpenTrace(AT, detail));
  render(
    <Wrapper>
      <RequestsLayer api={api}>
        <TraceBar
          at={AT}
          hostKey={HOST}
          workspaceId="w"
          traceId={detail.summary.id}
          spanId={null}
        />
      </RequestsLayer>
    </Wrapper>
  );

  return { navigation, lookups };
};

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

test("a Send's trace says so and offers Resend before Add to agent session", async () => {
  const detail = traceOf("polaris");

  mount(detail, [sendFor(detail, null)]);

  const resend = await screen.findByTestId("trace-resend");
  const actions = [...screen.getByTestId("trace-bar").querySelectorAll("button")];

  expect(screen.getByTestId("trace-bar-from-requests").textContent).toBe(" · from Requests");
  expect(resend.textContent).toContain("Resend in Requests");
  expect(actions.map((b) => b.dataset.testid)).toEqual(["trace-resend", "trace-add-to-session"]);
});

test.each([
  ["another service's HTTP trace", "api", true, [], 0],
  ["a polaris trace no Send started", "polaris", true, [], 1],
  ["a Host whose Daemon lacks requests", "polaris", false, ["send"], 0],
] as const)("%s gets no Resend", async (_name, service, capable, sends, asked) => {
  const detail = traceOf(service);
  const { lookups } = mount(detail, sends.length === 0 ? [] : [sendFor(detail, null)], capable);

  await screen.findByTestId("trace-bar");
  await settle();

  expect(screen.queryByTestId("trace-resend")).toBeNull();
  expect(screen.queryByTestId("trace-bar-from-requests")).toBeNull();
  expect(lookups.length).toBe(asked);
});

test("Resend opens Requests with the saved Request the Send sent selected", async () => {
  const detail = traceOf("polaris");
  const ref = { file: "http/invoices.http", name: "Recalculate overdue" };
  const { navigation } = mount(detail, [sendFor(detail, ref)]);

  fireEvent.click(await screen.findByTestId("trace-resend"));

  const view = requestsView(AT);

  expect(navigation.store.getState().mode).toBe("requests");
  expect(view.open).toBe(`${ref.file}\u0000${ref.name}`);
  expect(view.environment).toBe("staging");
  expect(view.drafts).toEqual({});
});

test("Resend of an ad-hoc Send opens what was sent, without its traceparent", async () => {
  const detail = traceOf("polaris");
  const { navigation } = mount(detail, [sendFor(detail, null)]);

  fireEvent.click(await screen.findByTestId("trace-resend"));

  const view = requestsView(AT);
  const draft = view.open === null ? undefined : view.drafts[view.open];

  expect(navigation.store.getState().mode).toBe("requests");
  expect(draft).toMatchObject({
    method: "POST",
    url: "http://localhost:4000/invoices/recalculate",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: '{ "overdue": true }',
    line: null,
  });
});
