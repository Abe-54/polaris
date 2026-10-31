/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/**
 * P10 repro harness: one connected Host "mac" ("This Mac") with Workspaces sightline (agent
 * session s1) and ledger, as P10's own app.testing.tsx, but handing back the store to mutate.
 */
import "../../../../apps/desktop/src/renderer/test/dom.testing.ts";
import type {
  Capability,
  HarnessKind,
  SessionState,
} from "../../../../packages/protocol/src/index.ts";
import { TooltipProvider } from "../../../../packages/ui/src/index.ts";
import type { ReactNode } from "react";
import { act, createStore, render } from "./deps.ts";
import { createCommandRegistry } from "../../../../apps/desktop/src/renderer/routes/commands.ts";
import {
  hostModel,
  hostView,
} from "../../../../apps/desktop/src/renderer/routes/fixtures.testing.ts";
import { createNavigation } from "../../../../apps/desktop/src/renderer/routes/navigation.ts";
import { AppProvider } from "../../../../apps/desktop/src/renderer/shell/hooks.ts";
import {
  type AppState,
  type Connection,
  initialState,
} from "../../../../apps/desktop/src/renderer/store/store.ts";

export const mountP10 = async (
  ui: ReactNode,
  {
    capabilities,
    state = "idle",
    harness = "claude",
  }: {
    readonly capabilities: ReadonlyArray<Capability>;
    readonly state?: SessionState;
    readonly harness?: HarnessKind;
  }
) => {
  const base = hostView("mac");
  const model = hostModel([{ id: "sightline", sessions: [{ id: "s1", state }] }, { id: "ledger" }]);
  const s1 = model.sessions.get("s1");
  const sessions = new Map(model.sessions);

  if (s1 !== undefined) sessions.set("s1", { ...s1, session: { ...s1.session, harness } });

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [{ ...base, label: "This Mac", status: { ...base.status, capabilities } }],
    hostModels: { mac: { ...model, sessions } },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>{ui}</TooltipProvider>
    </AppProvider>
  );

  await act(async () => undefined);

  return { store };
};
