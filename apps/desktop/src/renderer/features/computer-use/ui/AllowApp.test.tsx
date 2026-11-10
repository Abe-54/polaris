import { AppId, ComputerUseState, ComputerUseStatus } from "@polaris/protocol";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerUseActions } from "../hooks.ts";
import type { HostFacts } from "../model.ts";
import { ComputerUseCard } from "./ComputerUseCard.tsx";

afterEach(cleanup);

const LOCAL: HostFacts = { name: "Mac Studio", platform: "macos", local: true };

const REMOTE: HostFacts = { name: "lucas-rpi", platform: "linux", local: false };

const harness = (picked: { id: string; name: string } | null) => {
  const added: Array<string> = [];

  const actions: ComputerUseActions = {
    busy: false,
    opened: undefined,
    setOn: () => undefined,
    openSetup: () => undefined,
    checkAgain: () => undefined,
    remove: () => undefined,
    add: async (appId) => {
      added.push(appId);

      return true;
    },
    pickApp: async () =>
      picked === null ? null : { id: AppId.make(picked.id), name: picked.name },
  };

  return { actions, added };
};

const show = (host: HostFacts, actions: ComputerUseActions) => {
  render(
    <ComputerUseCard
      host={host}
      feed={{
        status: ComputerUseStatus.make({
          state: ComputerUseState.cases.Ready.make({}),
          checkedAt: new Date().toISOString(),
        }),
        allowed: [],
        controlled: [],
      }}
      actions={actions}
    />
  );

  return within(document.body);
};

describe("Allow an app…", () => {
  test("on this Mac, a picked refused app warns before it is always-allowed", async () => {
    const { actions, added } = harness({ id: "com.apple.Terminal", name: "Terminal" });
    const page = show(LOCAL, actions);

    act(() => void fireEvent.click(page.getByText("Allow an app…")));
    const warning = await waitFor(() => page.getByRole("alert"));

    expect(warning.textContent).toContain("Polaris never lets agents use Terminal by default");
    expect(added).toEqual([]);

    act(() => void fireEvent.click(page.getByText("Always allow Terminal anyway")));
    await waitFor(() => expect(added).toEqual(["com.apple.Terminal"]));
  });

  test("an ordinary app is allowed without a warning, and Cancel adds nothing", async () => {
    const { actions, added } = harness({ id: "com.apple.Safari", name: "Safari" });
    const page = show(LOCAL, actions);

    act(() => void fireEvent.click(page.getByText("Allow an app…")));
    await waitFor(() => page.getByText("Always allow Safari"));
    expect(page.queryByRole("alert")).toBeNull();

    act(() => void fireEvent.click(page.getByText("Cancel")));
    expect(page.queryByText("Always allow Safari")).toBeNull();
    expect(added).toEqual([]);
  });

  test("on another Host, a typed id is checked for its shape, then warned about when refused", async () => {
    const { actions, added } = harness(null);
    const page = show(REMOTE, actions);

    act(() => void fireEvent.click(page.getByText("Allow an app…")));
    const field = page.getByLabelText("App id");

    act(() => void fireEvent.change(field, { target: { value: "/usr/bin/konsole" } }));
    act(() => void fireEvent.click(page.getByText("Next")));
    expect(page.getByText("A .desktop id has no slashes")).toBeTruthy();

    act(() => void fireEvent.change(field, { target: { value: "org.kde.konsole" } }));
    act(() => void fireEvent.click(page.getByText("Next")));
    expect(page.getByRole("alert").textContent).toContain("on lucas-rpi");

    act(() => void fireEvent.click(page.getByText("Always allow org.kde.konsole anyway")));
    await waitFor(() => expect(added).toEqual(["org.kde.konsole"]));
  });
});
