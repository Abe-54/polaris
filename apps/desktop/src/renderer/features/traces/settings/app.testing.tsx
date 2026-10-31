/**
 * The app around a Traces settings or setup test: one connected Host ("mac", "This Mac") with
 * Workspaces sightline and ledger, sightline holding agent session s1 in `state`.
 */
import type { Capability, SessionState } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";

export const mountApp = async (
  ui: ReactNode,
  {
    capabilities,
    state = "idle",
  }: { readonly capabilities: ReadonlyArray<Capability>; readonly state?: SessionState }
) => {
  const base = hostView("mac");

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [{ ...base, label: "This Mac", status: { ...base.status, capabilities } }],
    hostModels: {
      mac: hostModel([{ id: "sightline", sessions: [{ id: "s1", state }] }, { id: "ledger" }]),
    },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  render(
    <AppProvider
      value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
    >
      <TooltipProvider>{ui}</TooltipProvider>
    </AppProvider>
  );

  await act(async () => undefined);

  return { navigation };
};
