import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { AttachmentsPage } from "./AttachmentsPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
  fake.answerOk("attachments.settings", {
    settings: { default: { kind: "on-archive" }, workspaces: { dotfiles: { kind: "never" } } },
    usage: {
      total: { bytes: 3 * 1024 * 1024, files: 5 },
      workspaces: {
        polaris: { bytes: 2 * 1024 * 1024, files: 4 },
        dotfiles: { bytes: 1024 * 1024, files: 1 },
      },
    },
  });
  fake.answerOk("attachments.clear", { bytes: 3 * 1024 * 1024, files: 5 });
});

afterEach(cleanup);

const supported = (host: HostView): HostView => ({
  ...host,
  status: { ...host.status, capabilities: ["attachments.settings"] },
});

const mount = async (hosts: ReadonlyArray<HostView>) => {
  const state: AppState = {
    ...initialState,
    hosts,
    hostModels: { mac: hostModel([{ id: "polaris" }, { id: "dotfiles" }, { id: "site" }]) },
  };

  const store = createStore<AppState>(() => state);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  await act(async () => {
    render(
      <AppProvider
        value={{
          connection,
          navigation: createNavigation({ app: store, storage: null }),
          commands: createCommandRegistry({ platform: "mac" }),
        }}
      >
        <AttachmentsPage />
      </AppProvider>
    );
  });

  return (key: string) => {
    const card = screen
      .getAllByTestId("attachments-host")
      .find((el) => el.getAttribute("data-host") === key);

    if (card === undefined) throw new Error(`no card for ${key}`);

    return within(card);
  };
};

test("a host's card shows what each workspace holds and its own override", async () => {
  const card = await mount([supported(hostView("mac"))]);

  expect(card("mac").getByTestId("staged-total").textContent).toBe("3.0 MB in 5 files");
  expect(card("mac").getByText("2.0 MB in 4 files")).toBeTruthy();
  expect(card("mac").getByText("polaris 2.0 MB")).toBeTruthy();
  expect(card("mac").getByText("site · Nothing staged")).toBeTruthy();
  expect(card("mac").getByText("3 workspaces · 1 override")).toBeTruthy();
});

test("× drops a workspace's override so it follows the host again", async () => {
  const card = await mount([supported(hostView("mac"))]);

  await act(async () => {
    fireEvent.click(card("mac").getByRole("button", { name: "Follow the host for dotfiles" }));
  });

  expect(fake.sent("attachments.setSettings")).toEqual([
    { hostKey: "mac", settings: { default: { kind: "on-archive" }, workspaces: {} } },
  ]);
});

test("Clear now asks in place, says what happens, then clears the host and reloads", async () => {
  const card = await mount([supported(hostView("mac"))]);
  const mac = card("mac");

  fireEvent.click(mac.getByRole("button", { name: "Clear now" }));

  expect(fake.sent("attachments.clear")).toEqual([]);
  expect(
    mac.getByText(
      `Deletes them from mac now, unsent drafts' files too. Sent images show "No preview", and agents can't open them again.`
    )
  ).toBeTruthy();

  const loads = fake.sent("attachments.settings").length;

  await act(async () => {
    fireEvent.click(mac.getByRole("button", { name: "Delete 5 files" }));
  });

  expect(fake.sent("attachments.clear")).toEqual([{ hostKey: "mac", workspaceId: null }]);
  expect(fake.sent("attachments.settings").length).toBe(loads + 1);
});

test("Cancel backs out of Clear now without deleting anything", async () => {
  const card = await mount([supported(hostView("mac"))]);

  fireEvent.click(card("mac").getByRole("button", { name: "Clear now" }));
  fireEvent.click(card("mac").getByRole("button", { name: "Cancel" }));

  expect(fake.sent("attachments.clear")).toEqual([]);
  expect(card("mac").getByRole("button", { name: "Clear now" })).toBeTruthy();
});

test.each([
  [supported(hostView("mac", "offline")), "mac isn't connected; its settings show once it is"],
  [hostView("mac"), "The daemon on mac is too old to manage attachments"],
] as const)("a host it can't ask says why and asks nothing (%#)", async (host, line) => {
  const card = await mount([host]);

  expect(card("mac").getByText(line)).toBeTruthy();
  expect(fake.sent("attachments.settings")).toEqual([]);
});
