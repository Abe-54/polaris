import "../../../../test/dom.testing.ts";
import { TerminalOutput } from "@polaris/client";
import { type Capability, type Command, SessionId, TerminalId } from "@polaris/protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeBridge, installFakeBridge } from "../../../../test/bridge.testing.ts";
import { standInBridge } from "../../../bridge.ts";
import { INSTALL_COMMAND, SETUP_PROMPT } from "../../model/agentSetup.ts";
import type { SetupState } from "../../model/setup.ts";
import { mountApp } from "../../settings/app.testing.tsx";
import { FRESH_SETTINGS, SIGHTLINE_SETTINGS } from "../../settings/fixtures.ts";
import { tracesSettingsTarget } from "../../settings/focus.ts";
import { TracesSetup } from "./TracesSetup.tsx";
import { dismissedFixedCards, useSetupPlace } from "./useSetupPlace.ts";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
  tracesSettingsTarget.setState(null, true);
  dismissedFixedCards.setState(new Set(), true);
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const AT = { hostKey: "mac", sessionId: SessionId.make("s1") };

const EMPTY: SetupState = { kind: "empty", endpoint: "http://127.0.0.1:4319/otlp/abc" };

const Setup = ({ state }: { readonly state: SetupState }) => (
  <TracesSetup state={state} place={useSetupPlace(AT, "sightline")} />
);

const WITH_SETTINGS: ReadonlyArray<Capability> = ["traces", "traces.settings"];

const mount = (
  options: Parameters<typeof mountApp>[1] = { capabilities: WITH_SETTINGS },
  state: SetupState = EMPTY
) => mountApp(<Setup state={state} />, options);

const click = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await act(async () => undefined);
};

const commands = (): ReadonlyArray<Command> => fake.sent("dispatch").map((d) => d.command);

test("a fixed exporter's card lists each one at file:line and hands the change to the idle agent as its next turn", async () => {
  fake.answerOk("traces.settings", SIGHTLINE_SETTINGS);
  await mount();

  expect(screen.getByText("sightline sends its traces straight to Axiom")).toBeTruthy();

  const listed = screen.getAllByRole("listitem").map((li) => li.textContent);

  expect(listed).toEqual([
    "apps/web/src/instrumentation-node.ts:36node",
    "apps/bot/src/instrumentation.ts:13bun",
    "apps/gamedata/src/services/tracing.ts:35node",
  ]);

  await click("Ask an agent to make this change");

  const [sent] = commands();

  expect(sent?._tag).toBe("SendTurn");
  expect(sent?._tag === "SendTurn" ? sent.sessionId : null).toBe(AT.sessionId);

  for (const line of listed)
    expect(sent?._tag === "SendTurn" ? sent.prompt : "").toContain(
      line?.replace(/(node|bun)$/, "")
    );

  expect(screen.getByTestId("traces-fixed-asked").textContent).toContain("as its next turn");
});

test.each([
  ["working", "Steer"],
  ["needs-you", "StartSession"],
  ["failed", "StartSession"],
] as const)("asking while the agent session is %s sends %s", async (state, tag) => {
  fake.answerOk("traces.settings", SIGHTLINE_SETTINGS);
  await mount({ capabilities: WITH_SETTINGS, state });
  await click("Ask an agent to make this change");

  expect(commands().map((c) => c._tag)).toEqual([tag]);
});

test("Not now puts the card off and leaves the generic one-line change", async () => {
  fake.answerOk("traces.settings", SIGHTLINE_SETTINGS);
  await mount();
  await click("Not now");

  expect(screen.queryByTestId("traces-fixed-exporter")).toBeNull();
  expect(screen.getByText("An exporter with its URL fixed in code")).toBeTruthy();
});

test("Set up tracing installs the skill globally in a terminal, then starts an agent session in the same checkout", async () => {
  fake.answerOk("traces.settings", FRESH_SETTINGS);
  fake.answerOk("terminal.open", { terminalId: TerminalId.make("t1") });
  await mount();
  await click("Set up tracing");

  const [open] = fake.sent("terminal.open");

  expect(open?.cwd).toBe("/code/sightline");
  expect(open?.argv?.at(-1)).toBe(INSTALL_COMMAND);
  expect(INSTALL_COMMAND).toContain(" -g");
  expect(commands()).toEqual([]);

  await act(async () => {
    for (const feed of fake.feeds("terminal"))
      feed.listener.items([TerminalOutput.Exit({ code: 0 })]);
  });

  const [start] = commands();

  expect(start?._tag).toBe("StartSession");

  if (start?._tag !== "StartSession") return;
  expect(start.prompt).toBe(SETUP_PROMPT);
  expect(String(start.workspaceId)).toBe("sightline");
  expect(start.placement._tag).toBe("InPlace");
  expect(start.harness).toBe("claude");
  expect(screen.getByRole("button", { name: "Open agent session" })).toBeTruthy();
});

test("a failed install says so and starts nothing", async () => {
  fake.answerOk("traces.settings", FRESH_SETTINGS);
  fake.answerOk("terminal.open", { terminalId: TerminalId.make("t1") });
  await mount();
  await click("Set up tracing");

  await act(async () => {
    for (const feed of fake.feeds("terminal"))
      feed.listener.items([TerminalOutput.Exit({ code: 1 })]);
  });

  expect(commands()).toEqual([]);
  expect(screen.getByTestId("traces-setup-progress").textContent).toBe(
    "The install exited with code 1; its output is in the terminal"
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("Instrument Node automatically opens Settings → Traces on this workspace", async () => {
  fake.answerOk("traces.settings", FRESH_SETTINGS);
  const { navigation } = await mount();

  await click("Instrument Node automatically");

  expect(navigation.current().settings?.section).toBe("traces");
  expect(tracesSettingsTarget.getState()).toEqual({ hostKey: "mac", workspaceId: "sightline" });
});

test("a daemon without traces.settings gets no detection, no settings link and no request", async () => {
  await mount({ capabilities: ["traces"] });

  expect(fake.sent("traces.settings")).toEqual([]);
  expect(screen.queryByRole("button", { name: "Instrument Node automatically" })).toBeNull();
  expect(screen.getByRole("button", { name: "Set up tracing" })).toBeTruthy();
});

test("an app exporting elsewhere with fixed exporters gets the card instead of the forwarding note", async () => {
  fake.answerOk("traces.settings", SIGHTLINE_SETTINGS);
  await mount({ capabilities: WITH_SETTINGS }, { kind: "userExported" });

  expect(screen.getByTestId("traces-fixed-exporter")).toBeTruthy();
});
