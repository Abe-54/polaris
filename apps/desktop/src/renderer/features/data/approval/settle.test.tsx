import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ApprovalRequest, SessionId, TurnId } from "@polaris/protocol";
import { Predicate } from "effect";
import { createStore } from "zustand/vanilla";
import { Decisions } from "../../../commands.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { approve } from "../../needs-you/respond.ts";
import { FIXTURE_DATA_TARGET, FIXTURE_SESSIONS, fixtureDataApproval } from "../preview/fixtures.ts";
import { DATA_AT, dataHost, dataHostModel } from "../preview/scene.ts";
import { coveredPending, decisionStore } from "./decide.ts";
import { dataSourceTarget } from "./model.ts";
import { useSettleCoveredApprovals } from "./settle.ts";

let next = 0;

const asking = (
  sessionId: SessionId,
  database = "analytics",
  port = 3306,
  user: string = FIXTURE_DATA_TARGET.user
): ApprovalRequest =>
  fixtureDataApproval(sessionId, TurnId.make("turn-5"), undefined, {
    id: `r-settle-${++next}`,
    dataSource: { database, port, user },
  });

const target = (request: ApprovalRequest) => {
  const found = dataSourceTarget(request);

  if (found === null) throw new Error("a Data Source Approval");

  return found;
};

describe("which other requests an approval here answers", () => {
  const a = SessionId.make("s-a");
  const b = SessionId.make("s-b");
  const granted = asking(a);

  test.each([
    ["the same target, another session", asking(b), "target", true],
    ["another database on the server", asking(b, "events"), "target", false],
    ["another database, with the whole server approved", asking(b, "events"), "server", true],
    ["another server", asking(b, "analytics", 3307), "server", false],
    ["the same server as another user", asking(b, "events", 3306, "admin"), "server", false],
  ] as const)("%s", (_case, request, scope, answered) => {
    const grants = [{ hostKey: "local", target: target(granted), scope }];

    expect(
      coveredPending("local", [{ sessionId: b, request }], { decided: {}, grants })
    ).toHaveLength(answered ? 1 : 0);
  });

  test("never on another Host, nor a request answered here already", () => {
    const request = asking(b);
    const grants = [{ hostKey: "local", target: target(granted), scope: "target" as const }];
    const pending = [{ sessionId: b, request }];

    expect(coveredPending("remote", pending, { decided: {}, grants })).toEqual([]);
    expect(
      coveredPending("local", pending, { decided: { [request.id]: "denied" }, grants })
    ).toEqual([]);
  });
});

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
  // Approvals other test files made in this process would cover these requests too.
  decisionStore.setState({ scopes: {}, decided: {}, grants: [] });
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const Settler = () => {
  useSettleCoveredApprovals();

  return null;
};

test("approving one session's request answers another's for the same target (F3)", async () => {
  const model = dataHostModel();
  const sessions = new Map(model.sessions);
  const ids = [FIXTURE_SESSIONS.backfill.id, FIXTURE_SESSIONS.overdue.id] as const;
  const [first, second] = ids.map((id) => asking(id));

  if (first === undefined || second === undefined) throw new Error("two requests");

  for (const [id, request] of [
    [ids[0], first],
    [ids[1], second],
  ] as const) {
    const entry = sessions.get(id);

    if (entry !== undefined) sessions.set(id, { ...entry, pendingApprovals: [request] });
  }

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
      <Settler />
    </AppProvider>
  );

  await approve({ hostKey: DATA_AT.hostKey, sessionId: ids[0], request: first });

  await waitFor(() =>
    expect(
      bridge
        .sent("dispatch")
        .flatMap(({ command }) =>
          Predicate.isTagged(command, "RespondToApproval")
            ? [[command.sessionId, command.decision]]
            : []
        )
    ).toEqual([
      [ids[0], Decisions.Allow({ remember: true, dataScope: "target" })],
      [ids[1], Decisions.Allow({ remember: true, dataScope: "target" })],
    ])
  );
});
