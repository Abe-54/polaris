/**
 * Traces' Profile slots (sidebar, trace bar, waterfall, span panel, profile panel) as TracesMode
 * lays them out, for one Agent Session, on a ProfilesApi the test can watch, end and stall.
 */
import "../../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../../app/slots.tsx";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import type { HostView, IpcError } from "../../../../../shared/api.ts";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import type { AppState } from "../../../../store/store.ts";
import { DataLayer } from "../../../data/data/hooks.tsx";
import { fixtureDataApi } from "../../../data/preview/fixtureApi.ts";
import { TracesLayer } from "../../data/hooks.tsx";
import { ProfilesLayer } from "../../data/profiles.tsx";
import type { ProfileSnapshots, ProfilesApi } from "../../data/profilesApi.ts";
import { resetRestarts } from "../../model/profile/restarts.ts";
import { selectProfile } from "../../model/profile/store.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import { selectTrace, useTracesSelection } from "../../model/store.ts";
import { fixtureAppState, HOST, host } from "../../preview/appState.ts";
import { fixturePid } from "../../preview/build.ts";
import { fixtureTracesApi } from "../../preview/fixtureApi.ts";
import { BIG_TRACE, FIXTURE_SESSION } from "../../preview/fixtures.ts";
import { fixtureProfilesApi } from "../../preview/profiles.ts";
import { TracesSidebar } from "../Sidebar.tsx";
import { SpanPanel } from "../SpanPanel.tsx";
import { TraceBar } from "../TraceBar.tsx";
import { TraceMain } from "../TraceMain.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";

export const AT: TracesSessionKey = { hostKey: HOST, sessionId: FIXTURE_SESSION };

export const LEDGER_PID = Number(fixturePid("ledger-api"));

/** The fixture Host in another Connection State or epoch. */
export const hostIn = (state: "connected" | "reconnecting", epoch: number): HostView => {
  if (host.status.state !== "connected") throw new Error("the fixture Host is connected");
  const status = { ...host.status, epoch };

  return {
    ...host,
    status: state === "connected" ? status : { ...status, state, attempt: 2 },
  };
};

interface Watch {
  readonly on: ProfileSnapshots;
  readonly stop: () => void;
  closed: boolean;
}

/** Wraps a ProfilesApi so the test sees every `profiles.watch` and can end them all. */
export const watching = (inner: ProfilesApi) => {
  const watches: Array<Watch> = [];

  const api: ProfilesApi = {
    ...inner,
    watch: (at, on) => {
      const watch: Watch = { on, stop: inner.watch(at, on), closed: false };

      watches.push(watch);

      return () => {
        watch.closed = true;
        watch.stop();
      };
    },
  };

  return {
    api,
    opened: () => watches.length,
    /** Ends every open watch, as the main process does when the connection drops. */
    dropAll: (error: IpcError | null) =>
      act(() => {
        for (const w of watches)
          if (!w.closed) {
            w.closed = true;
            w.stop();
            w.on.end?.(error);
          }
      }),
  };
};

const Slots = ({ at }: { readonly at: TracesSessionKey }) => {
  const props = { at, hostKey: at.hostKey, workspaceId: "ledger", ...useTracesSelection(at) };

  return (
    <>
      <TracesSidebar {...props} />
      <TraceBar {...props} />
      <TraceMain {...props} />
      <SpanPanel {...props} />
      <ProfilePanel {...props} />
    </>
  );
};

export const mountProfiles = ({
  profiles = fixtureProfilesApi({ owned: [LEDGER_PID] }),
  shown = host,
}: { readonly profiles?: ProfilesApi; readonly shown?: HostView } = {}) => {
  const store = createStore<AppState>(() => ({ ...fixtureAppState(shown), density: "calm" }));
  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  navigation.actions.selectSession(AT);
  navigation.actions.setMode("traces");
  // The shell provides this fact while Traces shows (shell/commands.ts).
  commands.provide(() => ({ keys: ["mode.traces"] }));
  // The per-session stores outlive a test.
  resetRestarts();
  selectProfile(AT, null);
  selectTrace(AT, BIG_TRACE.id);

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation,
        commands,
      }}
    >
      <TooltipProvider>
        <DataLayer api={fixtureDataApi()}>
          <TracesLayer api={fixtureTracesApi()}>
            <ProfilesLayer api={profiles}>
              <Slots at={AT} />
            </ProfilesLayer>
          </TracesLayer>
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { at: AT, store, navigation, commands };
};

export const openProfilesTab = async () => {
  fireEvent.click(screen.getByRole("radio", { name: /Profiles/ }));
  await screen.findByTestId("profiles-list");
};
