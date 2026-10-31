/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/**
 * P5 repros (Profiles in ⌘5, ENG-657). Each test names a finding in the RPU review and fails on
 * 99ca0343d; it should pass once that finding is fixed.
 */
import { afterEach, expect, test } from "bun:test";
import type { ProfileDetail } from "../../../../packages/protocol/src/index.ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "./deps.ts";
import type { ProfilesApi } from "../../../../apps/desktop/src/renderer/features/traces/data/profilesApi.ts";
import { onDraftChange, updateDraft } from "../../../../apps/desktop/src/renderer/features/session/state.ts";
import { flameLayout } from "../../../../apps/desktop/src/renderer/features/traces/model/profile/flame.ts";
import {
  profileSelection,
  selectProfile,
} from "../../../../apps/desktop/src/renderer/features/traces/model/profile/store.ts";
import {
  selectSpan,
  selectTrace,
} from "../../../../apps/desktop/src/renderer/features/traces/model/store.ts";
import { fixturePid } from "../../../../apps/desktop/src/renderer/features/traces/preview/build.ts";
import { ERROR_TRACE } from "../../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";
import {
  fixtureProfilesApi,
  LEDGER_PROFILE,
} from "../../../../apps/desktop/src/renderer/features/traces/preview/profiles.ts";
import {
  mountTraces,
  scripted,
} from "../../../../apps/desktop/src/renderer/features/traces/ui/mode.testing.tsx";
import { AT, hostIn, mountProfiles, watching } from "./harness.tsx";

afterEach(() => {
  cleanup();
  act(() => {
    selectProfile(AT, null);
    selectTrace(AT, null);
  });
});

const LEDGER_PID = Number(fixturePid("ledger-api"));

const openProfilesTab = async () => {
  fireEvent.click(screen.getByRole("radio", { name: /Profiles/ }));
  await screen.findByTestId("profiles-list");
};

const ledgerDetail = async (): Promise<ProfileDetail> => {
  const got = await fixtureProfilesApi().get(AT, LEDGER_PROFILE.id);

  if (!got.ok) throw new Error("the ledger fixture reads");

  return got.value;
};

test("finding P5-1: a Profile listed in a checkout with no traces opens when clicked", async () => {
  // No traces: Traces shows its setup page, and the sidebar still lists the recordings.
  mountTraces(scripted(() => []).api);
  await openProfilesTab();
  const rows = await screen.findAllByTestId("profiles-row");

  fireEvent.click(rows[1] ?? document.body);
  expect(rows[1]?.getAttribute("aria-current")).toBe("true");

  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

  expect(screen.queryByTestId("profile-panel") === null).toBe(false);
});

test("finding P5-2: after the connection drops and comes back, Profiles watches again", async () => {
  const fake = watching(fixtureProfilesApi());
  const { store } = mountProfiles({ profiles: fake.api });

  await openProfilesTab();
  await screen.findAllByTestId("profiles-row");
  expect(fake.opened()).toBe(1);

  // The main process ends profiles.watch with the connection (main/ipc/traces.ts).
  fake.dropAll({ code: "Disconnected", message: "The connection to Mac Studio closed" });
  act(() => store.setState({ hosts: [hostIn("reconnecting", 1)] }));
  act(() => store.setState({ hosts: [hostIn("connected", 2)] }));

  expect(fake.opened()).toBe(2);
  expect(screen.getAllByTestId("profiles-row").length).toBeGreaterThan(0);
});

test("finding P5-2: while the Host is reconnecting, Profiles keeps the last list", async () => {
  const fake = watching(fixtureProfilesApi());
  const { store } = mountProfiles({ profiles: fake.api });

  await openProfilesTab();
  await screen.findAllByTestId("profiles-row");

  act(() => store.setState({ hosts: [hostIn("reconnecting", 1)] }));
  fake.dropAll({ code: "Disconnected", message: "The connection to Mac Studio closed" });

  expect(screen.queryAllByTestId("profiles-row").length).toBe(4);
  expect(screen.getByTestId("profiles-list").textContent).not.toContain("connection");
});

test("finding P5-3: a refusal for one service doesn't stay under another service's button", async () => {
  mountProfiles({ profiles: fixtureProfilesApi({ owned: [] }) });
  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));
  await screen.findByRole("alert");

  // Open the failing test's trace: the button now restarts ledger-tests.
  act(() => selectTrace(AT, ERROR_TRACE.id));
  await waitFor(() =>
    expect(screen.getByTestId("profiles-restart").textContent).toContain("ledger-tests")
  );

  expect(screen.queryByTestId("profiles-refused")?.textContent ?? null).toBeNull();
});

test("finding P5-3: a restart still in flight keeps its button disabled across the tab switch", async () => {
  const base = fixtureProfilesApi({ owned: [LEDGER_PID] });
  const stalled: ProfilesApi = { ...base, restart: () => new Promise(() => undefined) };

  mountProfiles({ profiles: stalled });
  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));
  expect(screen.getByTestId("profiles-restart").hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: /Traces/ }));
  await openProfilesTab();

  expect(screen.getByTestId("profiles-restart").hasAttribute("disabled")).toBe(true);
});

test("finding P5-4: a restart the user clicked doesn't read as made by the agent", async () => {
  mountProfiles({ profiles: fixtureProfilesApi({ owned: [LEDGER_PID] }) });
  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));
  await screen.findByTestId("profile-panel");

  const newest = screen.getAllByTestId("profiles-row")[0];

  expect(newest?.getAttribute("aria-current")).toBe("true");
  expect(newest?.textContent).not.toContain("by the agent");
});

test("finding P5-5: a recording in progress doesn't show a read failure and 'Record it again'", async () => {
  mountProfiles({ profiles: fixtureProfilesApi({ owned: [LEDGER_PID] }) });
  await screen.findByTestId("waterfall");
  await openProfilesTab();
  fireEvent.click(await screen.findByTestId("profiles-restart"));
  const panel = await screen.findByTestId("profile-panel");

  await waitFor(() =>
    expect(within(panel).queryByText("Reading the profile…")).toBeNull()
  );

  expect(panel.textContent).not.toContain("Record it again");
});

test("finding P5-6: a frame chosen by keyboard outside the shown range brings it into view", async () => {
  const detail = await ledgerDetail();
  const layout = flameLayout(detail);

  mountProfiles();
  await screen.findByTestId("waterfall");
  act(() => selectProfile(AT, LEDGER_PROFILE));
  const chart = await screen.findByTestId("flame-chart");

  // The chart opens on 11,700–12,400 ms (the open trace's stretch); Left reaches the GC before.
  fireEvent.keyDown(chart, { key: "ArrowDown" });
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
  const { frame, window } = profileSelection(AT);

  if (frame === null) throw new Error("a frame is selected");
  const shown = window ?? { from: 11_700, to: 12_400 };

  expect((layout.start[frame] ?? 0) < shown.to && (layout.end[frame] ?? 0) > shown.from).toBe(
    true
  );
});

test("finding P5-7: the frame chosen on the canvas is announced to assistive technology", async () => {
  mountProfiles();
  await screen.findByTestId("waterfall");
  act(() => selectProfile(AT, LEDGER_PROFILE));
  const chart = await screen.findByTestId("flame-chart");

  fireEvent.keyDown(chart, { key: "ArrowDown" });
  const panel = screen.getByTestId("profile-panel");

  const announced = [...panel.querySelectorAll("[aria-live], [role='status']")].some((el) =>
    el.textContent?.includes("recalculateOverdue")
  );

  const described = [chart.getAttribute("aria-valuetext"), chart.getAttribute("aria-description")]
    .join(" ")
    .includes("recalculateOverdue");

  expect(announced || described).toBe(true);
});

test("finding P5-9: Restart with profiling waits for the Host to be connected", async () => {
  const { store } = mountProfiles({ profiles: fixtureProfilesApi({ owned: [LEDGER_PID] }) });

  await screen.findByTestId("waterfall");
  await openProfilesTab();
  await screen.findByTestId("profiles-restart");
  act(() => store.setState({ hosts: [hostIn("reconnecting", 1)] }));

  expect(screen.getByTestId("profiles-restart").hasAttribute("disabled")).toBe(true);
});

test("finding P5-10: dragging the whole recording never shows time before it started", async () => {
  mountProfiles();
  await screen.findByTestId("waterfall");
  act(() => selectProfile(AT, LEDGER_PROFILE));
  const chart = await screen.findByTestId("flame-chart");

  fireEvent.keyDown(chart, { key: "0" });
  expect(profileSelection(AT).window).toEqual({ from: 0, to: 12_400 });

  fireEvent.pointerDown(chart, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(chart, { clientX: 140, pointerId: 1 });
  fireEvent.pointerUp(chart, { clientX: 140, pointerId: 1 });

  expect(profileSelection(AT).window?.from ?? 0).toBeGreaterThanOrEqual(0);
});

test("finding P5-11: ⌘L in the profile panel adds the Profile after the trace bar re-registers", async () => {
  const { commands } = mountProfiles();
  const drafts: Array<string> = [];

  updateDraft(AT.hostKey, AT.sessionId, () => "");
  await screen.findByTestId("waterfall");
  act(() => selectProfile(AT, LEDGER_PROFILE));
  await screen.findByTestId("profile-add-to-session");
  act(() => screen.getByTestId("flame-chart").focus());

  // The trace bar's handler changes (here a span; live, the open trace re-reading as it grows).
  act(() => selectSpan(AT, "b30e4d1a7c2f9e05"));
  const stop = onDraftChange((_key, draft) => drafts.push(draft));

  act(() => {
    commands.run("traces.addToSession");
  });
  stop();

  expect(drafts.at(-1)).toStartWith("Profile `prof-ledger-api-12`");
});
