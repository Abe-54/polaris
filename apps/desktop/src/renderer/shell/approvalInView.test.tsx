import "../test/dom.testing.ts";
// The app loads its slots first; shell/commands.ts reaches them through a cycle.
import "../app/slots.tsx";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ApprovalRequest, TurnId } from "@polaris/protocol";
import { Predicate } from "effect";
import { createStore } from "zustand/vanilla";
import { Decisions } from "../commands.ts";
import { standInBridge } from "../features/bridge.ts";
import { setApprovalScope } from "../features/data/approval/decide.ts";
import { FIXTURE_SESSIONS, fixtureDataApproval } from "../features/data/preview/fixtures.ts";
import { DATA_AT, dataHost, dataHostModel } from "../features/data/preview/scene.ts";
import { createCommandRegistry } from "../routes/commands.ts";
import { createNavigation } from "../routes/navigation.ts";
import { type AppState, type Connection, initialState } from "../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../test/bridge.testing.ts";
import { useShownApproval } from "./approvalInView.ts";
import { shellCommands } from "./commands.ts";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

let next = 0;

/** Data Source Approvals on two sources, in one session. */
const requests = (count: number): ReadonlyArray<ApprovalRequest> =>
  Array.from({ length: count }, (_, i) =>
    fixtureDataApproval(FIXTURE_SESSIONS.backfill.id, TurnId.make("turn-5"), undefined, {
      id: `r-view-${++next}`,
      dataSource: { database: `db${i}` },
    })
  );

const Card = ({ request }: { readonly request: ApprovalRequest }) => (
  <section ref={useShownApproval(request.id)}>
    <button type="button">{`Approve ${request.id}`}</button>
  </section>
);

/** The shell's commands, Backfill currency selected with `pending` waiting and their cards shown. */
const mount = (pending: ReadonlyArray<ApprovalRequest>, shown = pending) => {
  const model = dataHostModel();
  const sessions = new Map(model.sessions);
  const backfill = sessions.get(FIXTURE_SESSIONS.backfill.id);

  if (backfill === undefined) throw new Error("No backfill session in the scene");
  sessions.set(backfill.session.id, { ...backfill, pendingApprovals: pending });

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost()],
    hostModels: { [DATA_AT.hostKey]: { ...model, sessions } },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  commands.register(shellCommands({ connection, navigation, dark: () => false }));
  act(() =>
    navigation.actions.selectSession({
      hostKey: DATA_AT.hostKey,
      sessionId: FIXTURE_SESSIONS.backfill.id,
    })
  );
  render(
    <>
      {shown.map((r) => (
        <Card key={r.id} request={r} />
      ))}
    </>
  );

  return commands;
};

const answered = () =>
  bridge
    .sent("dispatch")
    .flatMap(({ command }) =>
      Predicate.isTagged(command, "RespondToApproval")
        ? [[command.requestId, command.decision] as const]
        : []
    );

test("⌘⇧A answers the card the user is in, with the scope it shows (F4)", async () => {
  const [first, second] = requests(2);

  if (first === undefined || second === undefined) throw new Error("two requests");
  const commands = mount([first, second]);

  setApprovalScope(second.id, "server");
  act(() => screen.getByRole("button", { name: `Approve ${second.id}` }).focus());

  expect(commands.run("approval.approve")).toBe(true);
  await waitFor(() =>
    expect(answered()).toEqual([
      [second.id, Decisions.Allow({ remember: true, dataScope: "server" })],
    ])
  );
});

test("⌘⇧A answers the lowest card on screen, not the first pending (F4)", async () => {
  const [first, second] = requests(2);

  if (first === undefined || second === undefined) throw new Error("two requests");
  const commands = mount([first, second]);
  const sections = document.querySelectorAll("section");

  sections.forEach((section, i) => {
    section.getBoundingClientRect = () => new DOMRect(0, 100 + i * 300, 400, 200);
  });

  commands.run("approval.approve");
  await waitFor(() => expect(answered().map(([id]) => id)).toEqual([second.id]));
});

test("with several pending and none in view, ⌘⇧A answers none", () => {
  const commands = mount(requests(2), []);

  expect(commands.enabled("approval.approve")).toBe(false);
  commands.run("approval.approve");
  expect(answered()).toEqual([]);
});

test("the only one pending is answered from anywhere, as its card would (default: this database)", async () => {
  const [only] = requests(1);

  if (only === undefined) throw new Error("one request");
  const commands = mount([only], []);

  commands.run("approval.approve");
  await waitFor(() =>
    expect(answered()).toEqual([
      [only.id, Decisions.Allow({ remember: true, dataScope: "target" })],
    ])
  );
});
