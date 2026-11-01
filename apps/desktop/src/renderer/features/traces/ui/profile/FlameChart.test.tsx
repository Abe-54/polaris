import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { ProfileDetail } from "@polaris/protocol";
import { flameLayout } from "../../model/profile/flame.ts";
import { profileSelection, selectProfile } from "../../model/profile/store.ts";
import { fixtureProfilesApi, LEDGER_PROFILE } from "../../preview/profiles.ts";
import { AT, mountProfiles } from "./profiles.testing.tsx";

afterEach(cleanup);

const ledgerDetail = async (): Promise<ProfileDetail> => {
  const got = await fixtureProfilesApi().get(AT, LEDGER_PROFILE.id);

  if (!got.ok) throw new Error("the ledger fixture reads");

  return got.value;
};

const openLedger = async () => {
  mountProfiles();
  await screen.findByTestId("waterfall");
  act(() => selectProfile(AT, LEDGER_PROFILE));

  return screen.findByTestId("flame-chart");
};

test("a frame chosen by keyboard outside the shown range brings it into view", async () => {
  const layout = flameLayout(await ledgerDetail());
  const chart = await openLedger();

  // The chart opens on 11,700–12,400 ms (the open trace's stretch); Left reaches the GC before.
  fireEvent.keyDown(chart, { key: "ArrowDown" });
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
  const { frame, window } = profileSelection(AT);

  if (frame === null || window === null) throw new Error("a frame is selected and shown");

  expect(layout.start[frame] ?? 0).toBeLessThan(11_700);
  expect((layout.start[frame] ?? 0) < window.to && (layout.end[frame] ?? 0) > window.from).toBe(
    true
  );
  expect(window.to - window.from).toBe(700);
});

test("the frame chosen on the canvas is announced to assistive technology", async () => {
  const chart = await openLedger();

  fireEvent.keyDown(chart, { key: "ArrowDown" });
  const announce = screen.getByTestId("profile-frame-announce");

  expect(announce.getAttribute("aria-live")).toBe("polite");
  expect(announce.textContent).toMatch(/^recalculateOverdue · overdue\.ts:30 · .+ · level 1$/);
});

test("dragging the whole recording never shows time before it started", async () => {
  const chart = await openLedger();

  fireEvent.keyDown(chart, { key: "0" });
  expect(profileSelection(AT).window).toEqual({ from: 0, to: 12_400 });

  fireEvent.pointerDown(chart, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(chart, { clientX: 140, pointerId: 1 });
  fireEvent.pointerUp(chart, { clientX: 140, pointerId: 1 });

  expect(profileSelection(AT).window).toEqual({ from: 0, to: 12_400 });
  // Showing all of it, Escape has no zoom to clear and leaves the window alone.
  fireEvent.keyDown(chart, { key: "Escape" });
  expect(profileSelection(AT).window).toEqual({ from: 0, to: 12_400 });
});
