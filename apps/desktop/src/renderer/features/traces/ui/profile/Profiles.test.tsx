import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { HostView } from "../../../../../shared/api.ts";
import { editorRoute } from "../../../../routes/editor.ts";
import { onDraftChange, updateDraft } from "../../../session/state.ts";
import type { ProfilesApi } from "../../data/profilesApi.ts";
import { profileSelection, selectProfile } from "../../model/profile/store.ts";
import { selectSpan } from "../../model/store.ts";
import { host } from "../../preview/appState.ts";
import { fixtureProfilesApi, LEDGER_PROFILE } from "../../preview/profiles.ts";
import { mountProfiles as mount, openProfilesTab } from "./profiles.testing.tsx";

afterEach(cleanup);

const RECALCULATE = "b30e4d1a7c2f9e05";

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
      "ledger-api · bun12 sRestarted with profiling",
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
    "of this trace · 12 s recorded"
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
    "Profile `prof-ledger-api-12` in this checkout: `ledger-api · bun` (bun, pid 47118, 12 s recorded, turn 12)\nHottest: `recalculateOverdue` (src/invoices/overdue.ts:30)"
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

test("a restart the user clicked reads as theirs, and its recording waits for the process to stop", async () => {
  mount();
  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));
  const panel = await screen.findByTestId("profile-panel");
  const newest = screen.getAllByTestId("profiles-row")[0];

  expect(newest?.getAttribute("aria-current")).toBe("true");
  expect(newest?.textContent).toContain("Restarted with profiling by you · recording");
  // The runtime writes the profile when it stops: no read is tried, so no read failure shows.
  await waitFor(() => expect(within(panel).queryByText("Reading the profile…")).toBeNull());
  expect(panel.textContent).toContain("The flame chart shows once the process stops");
  expect(panel.textContent).not.toContain("Record it again");
});

test("⌘L in the profile panel still adds the Profile after the trace bar re-registers", async () => {
  const { at, commands } = mount();
  const drafts: Array<string> = [];

  updateDraft(at.hostKey, at.sessionId, () => "");
  await screen.findByTestId("waterfall");
  act(() => selectProfile(at, LEDGER_PROFILE));
  await screen.findByTestId("profile-add-to-session");
  act(() => screen.getByTestId("flame-chart").focus());

  // The trace bar's handler changes (here a span; live, the open trace re-reading as it grows).
  act(() => selectSpan(at, RECALCULATE));
  const stop = onDraftChange((_key, draft) => drafts.push(draft));

  act(() => {
    commands.run("traces.addToSession");
  });
  stop();

  expect(drafts.at(-1)).toStartWith("Profile `prof-ledger-api-12`");
});
