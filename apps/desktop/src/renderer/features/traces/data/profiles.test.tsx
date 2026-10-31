import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { fixtureProfilesApi } from "../preview/profiles.ts";
import {
  hostIn,
  mountProfiles,
  openProfilesTab,
  watching,
} from "../ui/profile/profiles.testing.tsx";

afterEach(cleanup);

const DISCONNECTED = { code: "Disconnected", message: "The connection to Mac Studio closed" };

test("after the connection drops and comes back, Profiles watches again", async () => {
  const fake = watching(fixtureProfilesApi());
  const { store } = mountProfiles({ profiles: fake.api });

  await openProfilesTab();
  await screen.findAllByTestId("profiles-row");
  expect(fake.opened()).toBe(1);

  // The main process ends profiles.watch with the connection (main/ipc/traces.ts).
  fake.dropAll(DISCONNECTED);
  act(() => store.setState({ hosts: [hostIn("reconnecting", 1)] }));
  act(() => store.setState({ hosts: [hostIn("connected", 2)] }));

  expect(fake.opened()).toBe(2);
  expect(screen.getAllByTestId("profiles-row")).toHaveLength(4);
});

test("while the Host is reconnecting, Profiles keeps the last list", async () => {
  const fake = watching(fixtureProfilesApi());
  const { store } = mountProfiles({ profiles: fake.api });

  await openProfilesTab();
  await screen.findAllByTestId("profiles-row");

  act(() => store.setState({ hosts: [hostIn("reconnecting", 1)] }));
  fake.dropAll(DISCONNECTED);

  expect(screen.queryAllByTestId("profiles-row")).toHaveLength(4);
  expect(screen.getByTestId("profiles-list").textContent).not.toContain("connection");
});
