import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@polaris/ui";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { HostView, RequestOutput } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { DEFAULT_POLICY, SOL } from "../model/reviewer.ts";
import { ReviewerPage } from "./ReviewerPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const host = (key: string, label: string, state: HostView["status"]["state"]): HostView => {
  const base = hostView(key, state);

  return {
    ...base,
    label,
    status: { ...base.status, capabilities: ["review.reviewer-settings"] },
  };
};

type Answer = RequestOutput<"review.reviewerSettings">;

const answer = (walkthrough: boolean): Answer => ({
  settings: {
    default: null,
    workspaces: { dotfiles: SOL },
    ...DEFAULT_POLICY,
    walkthrough: { enabled: walkthrough, harness: null, model: null, effort: null },
  },
  resolved: { choice: null, source: "auto", note: "Rules only" },
});

const mount = async (walkthrough = true) => {
  fake.answerOk("review.reviewerSettings", answer(walkthrough));

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [host("mac", "Mac Studio", "connected"), host("pi", "Raspberry Pi 4", "offline")],
    hostModels: { mac: hostModel([{ id: "dotfiles" }]) },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <ReviewerPage />
      </TooltipProvider>
    </AppProvider>
  );

  await act(async () => undefined);

  return within(screen.getByTestId("reviewer-card"));
};

test("automatic is drawn as its chain, ending in rules only", async () => {
  const card = await mount();

  expect(card.getByTestId("reviewer-title").textContent).toBe("Picks a reviewer automatically");
  expect(
    within(card.getByRole("list", { name: "Automatic picks" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent)
  ).toEqual(["Claude Code · Opus 5.5 high", "Codex · GPT-6.1-Sol", "Rules only"]);
});

test("an offline host dims and says it isn't connected", async () => {
  const card = await mount();
  const pi = card.getAllByTestId("reviewer-host").find((r) => r.dataset["host"] === "pi");

  expect(pi?.textContent).toContain("Not connected");
  expect(fake.sent("review.reviewerSettings")).toEqual([{ hostKey: "mac", workspaceId: null }]);
});

test("the walkthrough row shows only while walkthroughs are written", async () => {
  const on = await mount(true);

  expect(on.getByTestId("walkthrough-model").textContent).toContain(
    "Uses the reviewer's harness, model and effort"
  );
  cleanup();

  const off = await mount(false);

  expect(off.queryByTestId("walkthrough-model")).toBeNull();
});

test("Edit overrides opens the workspace reviewers, and × clears one on its host", async () => {
  const card = await mount();

  expect(card.getByText("1 workspace overrides the reviewer")).not.toBeNull();
  expect(card.queryByTestId("override")).toBeNull();

  act(() => {
    fireEvent.click(card.getByRole("button", { name: "Edit overrides" }));
  });
  await act(async () =>
    fireEvent.click(card.getByRole("button", { name: "Remove the override for dotfiles" }))
  );

  const [sent] = fake.sent("review.setReviewerSettings");

  expect(sent?.hostKey).toBe("mac");
  expect(sent?.settings.workspaces).toEqual({});
});
