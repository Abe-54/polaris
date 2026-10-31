import "../../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../../app/slots.tsx";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../../../shared/api.ts";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { editorRoute } from "../../../../routes/editor.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import type { AppState } from "../../../../store/store.ts";
import { DataLayer } from "../../../data/data/hooks.tsx";
import { fixtureDataApi } from "../../../data/preview/fixtureApi.ts";
import { onDraftChange, updateDraft } from "../../../session/state.ts";
import { TracesLayer } from "../../data/hooks.tsx";
import { ProfilesLayer } from "../../data/profiles.tsx";
import type { ProfilesApi } from "../../data/profilesApi.ts";
import { profileSelection, selectProfile } from "../../model/profile/store.ts";
import { selectSpan, selectTrace, useTracesSelection } from "../../model/store.ts";
import { fixtureAppState, HOST, host } from "../../preview/appState.ts";
import { fixturePid } from "../../preview/build.ts";
import { fixtureTracesApi } from "../../preview/fixtureApi.ts";
import { BIG_TRACE, FIXTURE_SESSION } from "../../preview/fixtures.ts";
import { fixtureProfilesApi, LEDGER_PROFILE } from "../../preview/profiles.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import { TracesSidebar } from "../Sidebar.tsx";
import { SpanPanel } from "../SpanPanel.tsx";
import { TraceMain } from "../TraceMain.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";

afterEach(cleanup);

const RECALCULATE = "b30e4d1a7c2f9e05";

const LEDGER_PID = Number(fixturePid("ledger-api"));

/** The slots that show a Profile, as TracesMode lays them out, for one Agent Session. */
const Slots = ({ at }: { readonly at: TracesSessionKey }) => {
  const props = { at, hostKey: at.hostKey, workspaceId: "ledger", ...useTracesSelection(at) };

  return (
    <>
      <TracesSidebar {...props} />
      <TraceMain {...props} />
      <SpanPanel {...props} />
      <ProfilePanel {...props} />
    </>
  );
};

const mount = ({
  profiles = fixtureProfilesApi({ owned: [LEDGER_PID] }),
  shown = host,
}: { readonly profiles?: ProfilesApi; readonly shown?: HostView } = {}) => {
  const at = { hostKey: HOST, sessionId: FIXTURE_SESSION };
  const store = createStore<AppState>(() => ({ ...fixtureAppState(shown), density: "calm" }));
  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  navigation.actions.selectSession(at);
  navigation.actions.setMode("traces");
  // The shell provides this fact while Traces shows (shell/commands.ts).
  commands.provide(() => ({ keys: ["mode.traces"] }));

  // The per-session stores outlive a test.
  selectProfile(at, null);
  selectTrace(at, BIG_TRACE.id);

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
              <Slots at={at} />
            </ProfilesLayer>
          </TracesLayer>
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { at, navigation, commands };
};

const openProfilesTab = async () => {
  fireEvent.click(screen.getByRole("radio", { name: /Profiles/ }));
  await screen.findByTestId("profiles-list");
};

test("Profiles lists recordings under their Turn, with process and how each was made", async () => {
  mount();
  await screen.findByTestId("waterfall");
  await openProfilesTab();

  expect((await screen.findByTestId("profiles-restart")).textContent).toContain(
    "Restart ledger-api with profiling"
  );

  const turns = screen.getAllByRole("listitem").map((group) => ({
    kicker: within(group).getByRole("heading").textContent,
    rows: within(group)
      .getAllByTestId("profiles-row")
      .map((row) => row.textContent),
  }));

  expect(turns[0]).toEqual({
    kicker: "TURN 12 · NOW2 profiles",
    rows: [
      "ledger-api · bun12.4 sRestarted with profiling by the agent",
      "bun test overdue-totals3.1 sWhole command",
    ],
  });
  expect(turns[1]?.rows).toEqual([
    expect.stringMatching(/^node scripts\/backfill-rates\.ts1\.8 sRecorded in turn 11 · /),
    "bun run seed–Recording failed",
  ]);
});

test("a restart the Daemon refuses says why; an owned one opens its new recording", async () => {
  const { at } = mount({ profiles: fixtureProfilesApi({ owned: [] }) });

  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Polaris didn't start this process"
  );
  expect(profileSelection(at).profile).toBeNull();

  cleanup();
  const owned = mount();

  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));

  expect((await screen.findByTestId("profile-header")).textContent).toContain("recording");
  expect(profileSelection(owned.at).profile?.status).toBe("recording");
  expect(screen.getAllByTestId("profiles-row")[0]?.getAttribute("aria-current")).toBe("true");
});

test("an open Profile names and marks the stretch of the trace it recorded", async () => {
  const { at } = mount();

  await screen.findByTestId("waterfall");
  act(() => {
    selectProfile(at, LEDGER_PROFILE);
    selectSpan(at, RECALCULATE);
  });

  // The recording ends 700 ms into the 840 ms overdue run.
  expect((await screen.findByTestId("profile-range")).textContent).toContain("0–700 ms");
  expect(screen.getByTestId("profile-header").textContent).toContain(
    "of this trace · 12.4 s recorded"
  );
  expect(screen.getByTestId("waterfall-profile-mark").style.width).toBe(`${(700 / 840) * 100}%`);

  // recalculateOverdue starts 10 ms in; its profiled part opens in the flame chart.
  const range = await screen.findByTestId("span-open-profile-range");

  expect(range.textContent).toContain("Open profile range10–700 ms");
  fireEvent.click(range);
  expect(profileSelection(at).window).toEqual({ from: 11_710, to: 12_400 });
});

test("selecting a frame by keyboard names it, and Enter opens its file:line in the Editor", async () => {
  const { at, navigation } = mount();

  act(() => selectProfile(at, LEDGER_PROFILE));
  const chart = await screen.findByTestId("flame-chart");

  fireEvent.keyDown(chart, { key: "ArrowDown" });
  fireEvent.keyDown(chart, { key: "ArrowDown" });

  expect(screen.getByTestId("profile-open-frame").textContent).toContain(
    "convertCurrency · fx.ts:8"
  );

  fireEvent.keyDown(chart, { key: "Enter" });

  expect(navigation.current().mode).toBe("edit");
  expect(editorRoute.getState().request).toMatchObject({
    path: "/Users/lucas/code/ledger.worktrees/overdue-totals/src/fx.ts",
    line: 8,
  });
});

test("a hot function in the checkout opens in the Editor; a native one isn't a link", async () => {
  const { at, navigation } = mount();

  act(() => selectProfile(at, LEDGER_PROFILE));
  const rows = await screen.findAllByTestId("hot-function");
  const fetchRate = rows.find((r) => r.textContent?.startsWith("fetchRate"));
  const parse = rows.find((r) => r.textContent?.startsWith("JSON.parse"));

  expect(parse?.tagName).toBe("DIV");
  expect(parse?.textContent).toContain("(native)");
  fireEvent.click(fetchRate ?? document.body);

  expect(navigation.current().mode).toBe("edit");
  expect(editorRoute.getState().request).toMatchObject({ line: 23 });
});

test("⌘L in the profile panel adds the Profile to the session's draft", async () => {
  const { at, commands } = mount();
  const drafts: Array<string> = [];

  // The draft store is shared across test files; start from an empty draft.
  updateDraft(at.hostKey, at.sessionId, () => "");
  const stop = onDraftChange((_key, draft) => drafts.push(draft));

  act(() => selectProfile(at, LEDGER_PROFILE));
  await screen.findByTestId("profile-add-to-session");
  act(() => screen.getByTestId("flame-chart").focus());
  act(() => {
    commands.run("traces.addToSession");
  });
  stop();

  expect(drafts.at(-1)).toStartWith(
    "Profile `prof-ledger-api-12` in this checkout: `ledger-api · bun` (bun, pid 47118, 12.4 s recorded, turn 12)\nHottest: `recalculateOverdue` (src/invoices/overdue.ts:30)"
  );
});

test("a Daemon without traces.profiles is never asked, and Profiles names the upgrade", async () => {
  let watched = 0;
  const api = fixtureProfilesApi();

  const counting: ProfilesApi = {
    ...api,
    watch: (at, on) => {
      watched++;

      return api.watch(at, on);
    },
  };

  if (host.status.state !== "connected") throw new Error("the fixture Host is connected");
  const capabilities = host.status.capabilities.filter((c) => c !== "traces.profiles");
  const older: HostView = { ...host, status: { ...host.status, capabilities } };

  mount({ profiles: counting, shown: older });
  await screen.findByTestId("waterfall");
  await openProfilesTab().catch(() => undefined);

  expect((await screen.findByTestId("profiles-quiet")).textContent).toContain(
    "Profiles need a newer daemon on Mac Studio. Update it in Settings → Hosts."
  );
  expect(watched).toBe(0);
});
