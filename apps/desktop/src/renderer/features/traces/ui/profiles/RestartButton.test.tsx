import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { ProfilesApi } from "../../data/profilesApi.ts";
import { selectTrace } from "../../model/store.ts";
import { ERROR_TRACE } from "../../preview/fixtures.ts";
import { fixtureProfilesApi } from "../../preview/profiles.ts";
import {
  AT,
  hostIn,
  LEDGER_PID,
  mountProfiles,
  openProfilesTab,
} from "../profile/profiles.testing.tsx";

afterEach(cleanup);

const restartButton = async () => {
  await screen.findByTestId("waterfall");
  await openProfilesTab();

  return screen.findByTestId("profiles-restart");
};

test("a refusal for one service doesn't stay under another service's button", async () => {
  mountProfiles({ profiles: fixtureProfilesApi({ owned: [] }) });
  fireEvent.click(await restartButton());
  await screen.findByRole("alert");

  // Open the failing test's trace: the button now restarts ledger-tests.
  act(() => selectTrace(AT, ERROR_TRACE.id));
  await waitFor(() =>
    expect(screen.getByTestId("profiles-restart").textContent).toContain("ledger-tests")
  );

  expect(screen.queryByTestId("profiles-refused")).toBeNull();
});

test("a restart still in flight keeps its button disabled across the tab switch", async () => {
  const base = fixtureProfilesApi({ owned: [LEDGER_PID] });
  const stalled: ProfilesApi = { ...base, restart: () => new Promise(() => undefined) };

  mountProfiles({ profiles: stalled });
  fireEvent.click(await restartButton());
  expect(screen.getByTestId("profiles-restart").hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: /Traces/ }));
  await openProfilesTab();

  expect(screen.getByTestId("profiles-restart").hasAttribute("disabled")).toBe(true);
  expect(screen.getByTestId("profiles-restart").textContent).toContain("Restarting ledger-api…");
});

test("Restart with profiling names the process it stops and waits for the Host to be connected", async () => {
  const { store } = mountProfiles();
  const button = await restartButton();

  expect(button.hasAttribute("disabled")).toBe(false);
  expect(screen.getByTestId("profiles-restart-consequence").textContent).toBe(
    `Stops pid ${LEDGER_PID} and starts it again with profiling`
  );

  act(() => store.setState({ hosts: [hostIn("reconnecting", 1)] }));

  expect(screen.getByTestId("profiles-restart").hasAttribute("disabled")).toBe(true);
});
