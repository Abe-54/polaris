/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/**
 * P5 repro harness: Traces' Profile slots (sidebar, trace bar, waterfall, span panel, profile
 * panel) as TracesMode lays them out, on a ProfilesApi the test can watch, end and stall.
 */
import "../../../../apps/desktop/src/renderer/test/dom.testing.ts";
import "../../../../apps/desktop/src/renderer/app/slots.tsx";
import { TooltipProvider } from "../../../../packages/ui/src/index.ts";
import { act, createStore, render } from "./deps.ts";
import type { HostView, IpcError } from "../../../../apps/desktop/src/shared/api.ts";
import { createCommandRegistry } from "../../../../apps/desktop/src/renderer/routes/commands.ts";
import { createNavigation } from "../../../../apps/desktop/src/renderer/routes/navigation.ts";
import { AppProvider } from "../../../../apps/desktop/src/renderer/shell/hooks.ts";
import type { AppState } from "../../../../apps/desktop/src/renderer/store/store.ts";
import { DataLayer } from "../../../../apps/desktop/src/renderer/features/data/data/hooks.tsx";
import { fixtureDataApi } from "../../../../apps/desktop/src/renderer/features/data/preview/fixtureApi.ts";
import { TracesLayer } from "../../../../apps/desktop/src/renderer/features/traces/data/hooks.tsx";
import { ProfilesLayer } from "../../../../apps/desktop/src/renderer/features/traces/data/profiles.tsx";
import type {
  ProfileSnapshots,
  ProfilesApi,
} from "../../../../apps/desktop/src/renderer/features/traces/data/profilesApi.ts";
import type { TracesSessionKey } from "../../../../apps/desktop/src/renderer/features/traces/model/session.ts";
import { selectProfile } from "../../../../apps/desktop/src/renderer/features/traces/model/profile/store.ts";
import {
  selectTrace,
  useTracesSelection,
} from "../../../../apps/desktop/src/renderer/features/traces/model/store.ts";
import {
  fixtureAppState,
  HOST,
  host,
} from "../../../../apps/desktop/src/renderer/features/traces/preview/appState.ts";
import { fixtureTracesApi } from "../../../../apps/desktop/src/renderer/features/traces/preview/fixtureApi.ts";
import {
  BIG_TRACE,
  FIXTURE_SESSION,
} from "../../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";
import { fixtureProfilesApi } from "../../../../apps/desktop/src/renderer/features/traces/preview/profiles.ts";
import { TracesSidebar } from "../../../../apps/desktop/src/renderer/features/traces/ui/Sidebar.tsx";
import { SpanPanel } from "../../../../apps/desktop/src/renderer/features/traces/ui/SpanPanel.tsx";
import { TraceBar } from "../../../../apps/desktop/src/renderer/features/traces/ui/TraceBar.tsx";
import { TraceMain } from "../../../../apps/desktop/src/renderer/features/traces/ui/TraceMain.tsx";
import { ProfilePanel } from "../../../../apps/desktop/src/renderer/features/traces/ui/profile/ProfilePanel.tsx";

export const AT: TracesSessionKey = { hostKey: HOST, sessionId: FIXTURE_SESSION };

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
  profiles = fixtureProfilesApi({ owned: [] }),
}: { readonly profiles?: ProfilesApi } = {}) => {
  const store = createStore<AppState>(() => ({ ...fixtureAppState(host), density: "calm" }));
  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  navigation.actions.selectSession(AT);
  navigation.actions.setMode("traces");
  commands.provide(() => ({ keys: ["mode.traces"] }));
  // The per-session stores outlive a test.
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

  return { store, navigation, commands };
};
