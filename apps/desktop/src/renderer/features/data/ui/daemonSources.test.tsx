/** Daemon Sources in Data's sidebar: where they show, the Polaris switch, and what can't change. */
import { DataSource, WorkspaceId } from "@polaris/protocol";
import { act, waitFor } from "@testing-library/react";
import { Schema } from "effect";
import { afterEach, describe, expect, test } from "bun:test";
import { hostDeveloperModesStore } from "../../settings/hostDeveloperModes.ts";
import { accessText, foundText } from "../model/source.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { DATA_AT } from "../preview/scene.ts";
import { click, mountData, page, useDataLayout } from "./data.testing.tsx";

useDataLayout();

const STATE = new DataSource({
  id: "src-daemon-state",
  name: "Daemon · state",
  engine: "sqlite",
  locality: "remote",
  host: "localhost",
  port: 0,
  database: "main",
  path: "/Users/me/.polaris/state.sqlite",
  foundIn: { kind: "daemon", file: "state.sqlite" },
  access: "read",
  writes: "off",
  label: { text: "DAEMON", colour: "grey" },
});

/** As the Daemon lists it with no Polaris Workspace: the user's alone. */
const USER_ONLY = new DataSource({
  ...Schema.encodeSync(DataSource)(STATE),
  access: "denied",
});

const mode = (polarisWorkspaceId: string | null) => ({
  stored: true,
  leases: 0,
  fromSource: false,
  effective: true,
  polarisWorkspaceId: polarisWorkspaceId === null ? null : WorkspaceId.make(polarisWorkspaceId),
  polarisWorkspaceSource: polarisWorkspaceId === null ? null : ("remote" as const),
});

afterEach(() => hostDeveloperModesStore.setState({}, true));

describe("Daemon Sources", () => {
  test("with no Polaris Workspace they wait for the Polaris switch, off by default", async () => {
    act(() => hostDeveloperModesStore.setState({ [DATA_AT.hostKey]: mode(null) }, true));
    mountData(fixtureDataApi({ sources: [...FIXTURE_SOURCES, STATE] }));

    const toggle = await waitFor(() =>
      page().getByRole("switch", { name: "Show the daemon's own databases" })
    );

    expect(page().queryByText("Daemon · state")).toBeNull();
    expect(page().getByText("app")).toBeTruthy();

    click(toggle);

    await waitFor(() => expect(page().getByText("Daemon · state")).toBeTruthy());
  });

  test("in the Polaris Workspace's checkouts they show with no switch", async () => {
    act(() => hostDeveloperModesStore.setState({ [DATA_AT.hostKey]: mode("w_polaris") }, true));
    mountData(fixtureDataApi({ sources: [...FIXTURE_SOURCES, STATE] }));

    await waitFor(() => expect(page().getByText("Daemon · state")).toBeTruthy());
    expect(page().queryByTestId("data-polaris-switch")).toBeNull();
  });

  test("without Daemon Sources there is no switch", async () => {
    act(() => hostDeveloperModesStore.setState({ [DATA_AT.hostKey]: mode(null) }, true));
    mountData(fixtureDataApi());

    await waitFor(() => expect(page().getByText("app")).toBeTruthy());
    expect(page().queryByTestId("data-polaris-switch")).toBeNull();
  });

  test("they read as the daemon's own, read by agents, never outside-the-checkout", () => {
    expect(foundText(STATE)).toBe("the daemon's own database · state.sqlite");
    expect(accessText(STATE)).toBe("Agents read · never written");
    expect(accessText(USER_ONLY)).toBe("Only you · agents read it in the Polaris workspace");
  });
});
