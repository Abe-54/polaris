import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ApprovalRequest } from "@polaris/protocol";
import { Toaster } from "@polaris/ui";
import { Predicate } from "effect";
import { Decisions } from "../../../commands.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { approve, deny } from "../../needs-you/respond.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import {
  credentialWrite,
  fixtureWrite,
  fixtureWriteApproval,
  fixtureWriteEntry,
  insertWrite,
  notPreviewedWrite,
  worstWrite,
} from "../preview/writeFixtures.ts";
import { type DataWrite, writeName } from "./model.ts";
import { WriteApprovalCard } from "./WriteApprovalCard.tsx";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const [APP, BRANCH] = FIXTURE_SOURCES;

const card = (request: ApprovalRequest, source = APP) => (
  <WriteApprovalCard
    hostKey="local"
    request={request}
    // SAFETY: fixtureWriteApproval always carries a dataWrite.
    write={request.dataWrite as DataWrite}
    who="Backfill currency"
    source={source}
    outcome={null}
    entry={undefined}
  />
);

const decisions = () =>
  bridge
    .sent("dispatch")
    .flatMap(({ command }) =>
      Predicate.isTagged(command, "RespondToApproval") ? [command.decision] : []
    );

test("Run sends one Allow, never remembered, and the card collapses to what ran", async () => {
  render(card(fixtureWriteApproval()));

  expect(screen.getByTestId("data-write-kicker").textContent).toBe(
    "Dry run · rolled back · 214 rows"
  );
  fireEvent.click(screen.getByTestId("data-write-run"));

  await waitFor(() => expect(decisions()).toEqual([Decisions.Allow({ remember: false })]));
  expect(screen.getByTestId("data-write-settled").textContent).toBe("Allowed 214-row update");
});

test("Deny needs a reason, and the reason is what the agent gets", async () => {
  render(card(fixtureWriteApproval()));

  fireEvent.click(screen.getByTestId("data-write-deny-open"));
  const send = screen.getByTestId("data-write-deny-send");

  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(send);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(decisions()).toEqual([]);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Use EUR for 2025  " } });
  fireEvent.click(screen.getByTestId("data-write-deny-send"));

  await waitFor(() =>
    expect(decisions()).toEqual([Decisions.Deny({ reason: "Use EUR for 2025" })])
  );
  expect(screen.getByTestId("data-write-settled").textContent).toBe("Denied: Use EUR for 2025");
});

test("Deny from the inbox, ⌘⇧D or a notification opens the reason field and sends nothing", async () => {
  const request = fixtureWriteApproval();
  let opened = false;

  render(card(request));
  expect(screen.queryByRole("textbox")).toBeNull();

  const sent = await act(() =>
    deny({ hostKey: "local", sessionId: request.sessionId, request }, () => {
      opened = true;
    })
  );

  expect(sent).toBe(false);
  expect(opened).toBe(true);
  expect(decisions()).toEqual([]);
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});

test("a remote source's card takes its label colour on the top bar; a local one has none", () => {
  const { unmount } = render(card(fixtureWriteApproval(), APP));

  expect(screen.queryByTestId("data-write-bar")).toBeNull();
  unmount();

  render(card(fixtureWriteApproval(fixtureWrite({ target: worstWrite().target })), BRANCH));
  expect(screen.getByTestId("data-write-bar").getAttribute("data-colour")).toBe("tan");
});

test("a schema change the Daemon didn't preview says so once, shows no rows and runs without preview", () => {
  const reason = "Not previewed: this statement changes the schema";

  render(card(fixtureWriteApproval(notPreviewedWrite(reason, "alter table t add column n int"))));

  expect(screen.getByTestId("data-write-kicker").textContent).toBe(reason);
  expect(screen.getAllByText(reason)).toHaveLength(1);
  expect(screen.queryByTestId("data-write-rows")).toBeNull();
  expect(screen.getByTestId("data-write-params").textContent).toBe("$1 = inv_04810");
  expect(screen.getByTestId("data-write-run").textContent).toContain("Run without preview");
});

test("an insert shows its new rows, the serial id as assigned on run, and that IDs are skipped (F8, F9)", () => {
  render(card(fixtureWriteApproval(insertWrite())));

  const rows = screen.getByTestId("data-write-rows");

  expect(rows.querySelectorAll('tr[data-side="after"]')).toHaveLength(3);
  expect(rows.querySelectorAll('tr[data-side="before"]')).toHaveLength(0);
  expect(
    [...rows.querySelectorAll('tr[data-side="after"] td:nth-child(2)')].map((td) => td.textContent)
  ).toEqual(["assigned on run", "assigned on run", "assigned on run"]);
  expect(screen.getByTestId("data-write-note").textContent).toBe(
    "IDs the preview used are skipped; the run gets new ones."
  );
});

test("a password reset shows the credential as redacted and changed, never as unchanged (F3)", () => {
  render(card(fixtureWriteApproval(credentialWrite())));

  const cells = [...screen.getByTestId("data-write-rows").querySelectorAll("[data-stand-in]")];

  expect(cells.map((td) => [td.textContent, td.getAttribute("data-change")])).toEqual([
    ["redacted", "changed"],
    ["redacted · changed", "changed"],
  ]);
});

test("the worst case shows the changed columns, 20 of the rows, and offers the rest", () => {
  render(card(fixtureWriteApproval(worstWrite()), BRANCH));

  const rows = screen.getByTestId("data-write-rows");

  expect(rows.querySelectorAll("tbody tr")).toHaveLength(40);
  expect(rows.querySelectorAll("thead th").length).toBeLessThanOrEqual(13);
  expect(screen.getByText("showing 20 of 1,204,118")).toBeTruthy();
  fireEvent.click(screen.getByText("Show all 256 columns"));
  expect(rows.querySelectorAll("thead th")).toHaveLength(257);
  expect(screen.getByText("Show the whole statement")).toBeTruthy();
});

test("Approve from outside a card on screen opens it and runs nothing: the SQL is seen first", async () => {
  const request = fixtureWriteApproval();
  let opened = false;

  // Rendered, but with no layout: not on screen.
  render(card(request));

  const sent = await act(() =>
    approve({ hostKey: "local", sessionId: request.sessionId, request }, false, () => {
      opened = true;
    })
  );

  expect(sent).toBe(false);
  expect(opened).toBe(true);
  expect(decisions()).toEqual([]);
});

/** Lays the card out in a conversation viewport from 0 to 600 px: where its parts sit, top/bottom. */
type Span = readonly [number, number];

const layOut = (parts: { readonly statement: Span; readonly run: Span }) => {
  const rect =
    ([top, bottom]: Span) =>
    () =>
      new DOMRect(0, top, 600, bottom - top);

  const viewport = document.querySelector<HTMLElement>("[data-approval-viewport]");
  const card = screen.getByTestId("data-write");

  if (viewport === null) throw new Error("no viewport");
  viewport.getBoundingClientRect = rect([0, 600]);
  card.getBoundingClientRect = rect([parts.statement[0] - 80, parts.run[1]]);

  for (const part of card.querySelectorAll<HTMLElement>("[data-approval-part]"))
    part.getBoundingClientRect = rect(
      part.dataset.approvalPart === "run" ? parts.run : parts.statement
    );
};

const inConversation = (request: ApprovalRequest) =>
  render(<div data-approval-viewport="">{card(request)}</div>);

const approveFromInbox = (request: ApprovalRequest) =>
  act(() => approve({ hostKey: "local", sessionId: request.sessionId, request }));

test.each([
  [
    "only the Run row in view, the SQL scrolled above",
    { statement: [-400, -100], run: [540, 590] },
  ],
  [
    "scrolled under the composer, in the window but not the conversation",
    { statement: [610, 690], run: [700, 740] },
  ],
] as const)(
  "Approve from elsewhere refuses a write with %s, and brings its card's top into view (F2)",
  async (_, parts) => {
    const request = fixtureWriteApproval();

    inConversation(request);
    layOut(parts);
    let scrolled: ScrollIntoViewOptions | boolean | undefined;

    screen.getByTestId("data-write").scrollIntoView = (options) => {
      scrolled = options;
    };

    act(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });

    expect(await approveFromInbox(request)).toBe(false);
    expect(decisions()).toEqual([]);
    expect(scrolled).toEqual({ block: "start" });
    expect(document.activeElement).toBe(screen.getByTestId("data-write"));
  }
);

test("Approve from the Inbox with the write's card nowhere on screen says where to review it", async () => {
  const request = fixtureWriteApproval();
  // SAFETY: fixtureWriteApproval always carries a dataWrite.
  const write = request.dataWrite as DataWrite;

  render(<Toaster />);

  expect(await approveFromInbox(request)).toBe(false);
  expect(decisions()).toEqual([]);
  expect(await screen.findByText(`Review the ${writeName(write)} in its session`)).not.toBeNull();
});

test("Approve from elsewhere runs a write whose SQL, dry run and Run row are all in view", async () => {
  const request = fixtureWriteApproval();

  inConversation(request);
  layOut({ statement: [40, 260], run: [500, 548] });

  expect(await approveFromInbox(request)).toBe(true);
  expect(decisions()).toEqual([Decisions.Allow({ remember: false })]);
});

test("⌘↵ in a card in view runs it", async () => {
  const request = fixtureWriteApproval();

  inConversation(request);
  layOut({ statement: [40, 260], run: [500, 548] });
  fireEvent.keyDown(screen.getByTestId("data-write-run"), { key: "Enter", metaKey: true });

  await waitFor(() => expect(decisions()).toEqual([Decisions.Allow({ remember: false })]));
});

test("⌘↵ in a card scrolled out of view runs nothing and brings its top into view", async () => {
  const request = fixtureWriteApproval();
  let scrolled = false;

  inConversation(request);
  layOut({ statement: [-400, -100], run: [540, 590] });
  screen.getByTestId("data-write").scrollIntoView = () => {
    scrolled = true;
  };

  fireEvent.keyDown(screen.getByTestId("data-write-run"), { key: "Enter", metaKey: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(decisions()).toEqual([]);
  expect(scrolled).toBe(true);
});

/** Every element laid out at `top`, 100 px tall, in the window: before mount, as focus reads it. */
const placeAll = (top: number) => {
  const spy = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, top, 600, 100)
  );

  return () => spy.mockRestore();
};

test.each([
  [10, true],
  [-500, false],
])(
  "a card that opens at %p px with nothing focused takes focus only when in view: %p",
  (top, focused) => {
    const restore = placeAll(top);

    try {
      render(card(fixtureWriteApproval()));
      expect(document.activeElement === screen.getByTestId("data-write")).toBe(focused);
    } finally {
      restore();
    }
  }
);

test("a card that opens never steals focus from where the user is typing", () => {
  const restore = placeAll(10);

  try {
    render(<input aria-label="composer" />);
    act(() => screen.getByLabelText("composer").focus());
    render(card(fixtureWriteApproval()));
    expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  } finally {
    restore();
  }
});

test("a write the Daemon couldn't preview looks riskier: its own kicker, the warning, no primary Run (F4)", () => {
  const { unmount } = render(card(fixtureWriteApproval()));

  expect(screen.getByTestId("data-write-run").dataset.variant).toBe("primary");
  expect(screen.queryByTestId("data-write-unpreviewed")).toBeNull();
  unmount();

  render(card(fixtureWriteApproval(notPreviewedWrite())));

  expect(screen.getByTestId("data-write-unpreviewed").textContent).toBe(
    "Not previewed: this table has triggersPolaris can't show which rows this changes."
  );
  expect(screen.getByTestId("data-write-run").dataset.variant).toBe("secondary");
});

test("an outcome-unknown write offers its table in Data from the settled line (F5)", () => {
  const request = fixtureWriteApproval();
  // SAFETY: fixtureWriteApproval always carries a dataWrite.
  const write = request.dataWrite as DataWrite;
  let opened = 0;

  render(
    <WriteApprovalCard
      hostKey="local"
      request={request}
      write={write}
      who="Backfill currency"
      source={APP}
      outcome={{ kind: "allowed" }}
      entry={fixtureWriteEntry(write, "unknown")}
      onOpenTable={() => opened++}
    />
  );

  const settled = screen.getByTestId("data-write-settled");

  expect(settled.dataset.state).toBe("unknown");
  fireEvent.click(screen.getByRole("button", { name: "Open in Data" }));
  expect(opened).toBe(1);
});
