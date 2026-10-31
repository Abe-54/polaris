/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/** P10 repros (ENG-657): Set up tracing and the fixed-exporter card. Expected to FAIL on 99ca0343d. */
import "../../../../apps/desktop/src/renderer/test/dom.testing.ts";
import { TerminalOutput } from "../../../../packages/client/src/index.ts";
import {
  type Command,
  type HarnessKind,
  SessionId,
  TerminalId,
} from "../../../../packages/protocol/src/index.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "./deps.ts";
import { mountP10 } from "./harness.tsx";
import {
  type FakeBridge,
  installFakeBridge,
} from "../../../../apps/desktop/src/renderer/test/bridge.testing.ts";
import { standInBridge } from "../../../../apps/desktop/src/renderer/features/bridge.ts";
import {
  fixedExporterPrompt,
  INSTALL_COMMAND,
} from "../../../../apps/desktop/src/renderer/features/traces/model/agentSetup.ts";
import {
  FIXED_EXPORTER_CHANGE,
  type SetupState,
} from "../../../../apps/desktop/src/renderer/features/traces/model/setup.ts";
import {
  FRESH_SETTINGS,
  SIGHTLINE_SETTINGS,
} from "../../../../apps/desktop/src/renderer/features/traces/settings/fixtures.ts";
import { tracesSettingsTarget } from "../../../../apps/desktop/src/renderer/features/traces/settings/focus.ts";
import { TracesSetup } from "../../../../apps/desktop/src/renderer/features/traces/ui/setup/TracesSetup.tsx";
import {
  dismissedFixedCards,
  useSetupPlace,
} from "../../../../apps/desktop/src/renderer/features/traces/ui/setup/useSetupPlace.ts";

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

const Setup = () => <TracesSetup state={EMPTY} place={useSetupPlace(AT, "sightline")} />;

const commands = (): ReadonlyArray<Command> => fake.sent("dispatch").map((d) => d.command);

/** The one variable the Daemon gives a launched command (apps/daemon/src/traces/runtime.ts:109). */
const POLARIS_ENV = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319/otlp/tok" };

const VENDOR = "https://api.axiom.co/v1/traces";

/** Evaluates the card's one-line change as the object property it is, in a process with `env`. */
const urlUnder = (env: Record<string, string>): unknown =>
  new Function("process", "existingVendorUrl", `return ({ ${FIXED_EXPORTER_CHANGE} }).url;`)(
    { env },
    VENDOR
  );

test("finding P10-1: the fixed-exporter line sends traces to Polaris under the environment Polaris sets", () => {
  // The line is both the card's Copy text and the change the agent is told to make.
  expect(fixedExporterPrompt(SIGHTLINE_SETTINGS.detectedExporters)).toContain(
    FIXED_EXPORTER_CHANGE
  );

  const url = String(urlUnder(POLARIS_ENV));

  expect(url.startsWith(POLARIS_ENV.OTEL_EXPORTER_OTLP_ENDPOINT)).toBe(true);
  expect(urlUnder({})).toBe(VENDOR);
});

test.each([
  ["ends with an error", { code: "Disconnected", message: "the host went away" }],
  ["ends without one", undefined],
] as const)(
  "finding P10-3: when the terminal feed %s mid-install, Set up tracing doesn't hang on Installing",
  async (_how, error) => {
    fake.answerOk("traces.settings", FRESH_SETTINGS);
    fake.answerOk("terminal.open", { terminalId: TerminalId.make("t1") });
    await mountP10(<Setup />, { capabilities: ["traces", "traces.settings"] });

    fireEvent.click(screen.getByRole("button", { name: "Set up tracing" }));
    await act(async () => undefined);

    expect(screen.getByTestId("traces-setup-progress").textContent).toContain("Installing");

    const before = fake.feeds("terminal").length;

    await act(async () => {
      for (const feed of fake.feeds("terminal")) feed.listener.end(error);
    });

    // A Host that drops ends live feeds (main/ipc/feeds.ts onLive). A fix may resubscribe:
    // the install then finishes on the new feed and the agent starts.
    await act(async () => {
      for (const feed of fake.feeds("terminal").slice(before))
        feed.listener.items([TerminalOutput.Exit({ code: 0 })]);
    });

    const started = commands().some((c) => c._tag === "StartSession");
    const progress = screen.getByTestId("traces-setup-progress").textContent ?? "";

    const retry = screen
      .getAllByRole("button")
      .some(
        (b) => /^(Set up tracing|Try again)$/.test(b.textContent ?? "") && !b.hasAttribute("disabled")
      );

    expect({ started, stuck: progress.includes("Installing"), retry: started || retry }).toEqual({
      started,
      stuck: false,
      retry: true,
    });
  }
);

/** The `skills` CLI's agent ids for each Harness Polaris drives. */
const SKILLS_AGENT: Readonly<Record<string, string>> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini-cli",
  copilot: "github-copilot",
};

test.each(["opencode", "gemini", "copilot"] as const)(
  "finding P10-4: Set up tracing from a %s session starts an agent the skill was installed for",
  async (harness: HarnessKind) => {
    fake.answerOk("traces.settings", FRESH_SETTINGS);
    fake.answerOk("terminal.open", { terminalId: TerminalId.make("t1") });
    await mountP10(<Setup />, { capabilities: ["traces", "traces.settings"], harness });

    fireEvent.click(screen.getByRole("button", { name: "Set up tracing" }));
    await act(async () => undefined);

    const install = fake.sent("terminal.open")[0]?.argv?.at(-1) ?? "";

    await act(async () => {
      for (const feed of fake.feeds("terminal"))
        feed.listener.items([TerminalOutput.Exit({ code: 0 })]);
    });

    const start = commands().find((c) => c._tag === "StartSession");
    const started = start?._tag === "StartSession" ? start.harness : null;

    expect(install).toBe(INSTALL_COMMAND);
    expect(started).not.toBeNull();
    // The prompt says "Use the polaris-tracing skill"; the install must reach that Harness.
    expect(install.split(" ")).toContain(SKILLS_AGENT[String(started)] ?? String(started));
  }
);
