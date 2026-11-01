import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { AgentSession, type ApprovalRequest, TurnId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { fixtureDataApproval, FIXTURE_SESSIONS } from "../../data/preview/fixtures.ts";
import { DATA_AT, dataHost, dataHostModel } from "../../data/preview/scene.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { NeedsYouInbox } from "./Inbox.tsx";

afterEach(cleanup);

/** The inbox with Backfill currency Needs You on `request`. */
const mount = (request: ApprovalRequest) => {
  const model = dataHostModel();
  const sessions = new Map(model.sessions);
  const entry = sessions.get(FIXTURE_SESSIONS.backfill.id);

  if (entry === undefined) throw new Error("No backfill session in the scene");
  sessions.set(entry.session.id, {
    ...entry,
    session: new AgentSession({ ...entry.session, state: "needs-you" }),
    pendingApprovals: [request],
  });

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost()],
    hostModels: { [DATA_AT.hostKey]: { ...model, sessions } },
  }));

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <NeedsYouInbox />
      </TooltipProvider>
    </AppProvider>
  );

  return within(document.body).getByTestId("needs-you-card");
};

test("a Data Source Approval offers Approve and Deny, never Always here (F4)", () => {
  const card = mount(fixtureDataApproval(FIXTURE_SESSIONS.backfill.id, TurnId.make("turn-5")));

  expect(within(card).getByRole("button", { name: "Approve" })).not.toBeNull();
  expect(within(card).queryByRole("button", { name: "Always here" })).toBeNull();
});

test("any other approval still offers Always here", () => {
  const { dataSource: _target, ...rest } = fixtureDataApproval(
    FIXTURE_SESSIONS.backfill.id,
    TurnId.make("turn-5")
  );

  const command: ApprovalRequest = {
    ...rest,
    kind: "command",
    title: "Run bun test",
    detail: "bun test",
  };

  expect(within(mount(command)).getByRole("button", { name: "Always here" })).not.toBeNull();
});

test("inspector approval never offers Always here", () => {
  const { dataSource: _source, ...base } = fixtureDataApproval(
    FIXTURE_SESSIONS.backfill.id,
    TurnId.make("turn-5")
  );

  const card = mount({
    ...base,
    kind: "tool",
    title: "Profile Node process 42 for 5 s",
    detail:
      "node server.js · pid 42 · Node · profile for 5 s\nwhile attached, any local process can run code in it",
    profileAttach: { pid: 42, command: "node server.js", runtime: "node", seconds: 5 },
  });

  expect(within(card).getByRole("button", { name: "Approve" })).not.toBeNull();
  expect(within(card).queryByRole("button", { name: "Always here" })).toBeNull();
});
