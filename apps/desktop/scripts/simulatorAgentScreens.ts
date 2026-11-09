#!/usr/bin/env node
/**
 * An agent drives the Simulator end to end (ENG-829) on this Mac: a real Claude Code session on
 * your account opens a throwaway iPhone with polaris_simulator and taps through Settings, while
 * the Desktop App shows the dot, the agent strip and the live stream. Then user input, Restart,
 * and the idle stop, which shuts down the iPhone the agent booted and not one the user booted.
 *
 *   POLARIS_E2E_SIMULATOR_AGENT=1 node scripts/simulatorAgentScreens.ts <out dir>
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { initRepo } from "./lib/sessionFlow.ts";

if (process.env.POLARIS_E2E_SIMULATOR_AGENT !== "1") {
  console.error("Runs a real Claude Code Turn on your account; set POLARIS_E2E_SIMULATOR_AGENT=1.");
  process.exit(2);
}

const out = process.argv[2] ?? "/tmp/polaris-simulator-agent";

mkdirSync(out, { recursive: true });

const t0 = Date.now();

const step = (message: string) =>
  console.log(`simulator-agent +${((Date.now() - t0) / 1000).toFixed(1)}s: ${message}`);

const simctl = (...args: ReadonlyArray<string>) =>
  execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 }).trim();

const stateOf = (udid: string) => {
  const line =
    simctl("list", "devices")
      .split("\n")
      .find((l) => l.includes(udid)) ?? "";

  return /\((Booted|Shutdown|Booting|Shutting Down)\)/.exec(line)?.[1] ?? "unknown";
};

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";

const TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";

const AGENT_NAME = "Polaris E agent iPhone";

/** The agent's iPhone starts shut down: the agent boots it, so the idle stop shuts it down. */
const agentPhone = simctl("create", AGENT_NAME, TYPE, RUNTIME);

/** Booted by the user before Polaris starts: the idle stop must leave it running. */
const userPhone = simctl("create", "Polaris E user iPhone", TYPE, RUNTIME);

simctl("boot", userPhone);

const IDLE_MS = 20_000;

interface Phones {
  readonly agent: string;
  readonly user: string;
}

/** What the run saw, written to `results.json` for the report. */
interface Results {
  readonly agentPhone: string;
  readonly userPhone: string;
  readonly idleMs: number;
  drivingStrip?: string;
  homeEnabledWhileDriving?: boolean;
  lastPhase?: string;
  approvals?: number;
  reply?: string;
  beforeIdle?: Phones;
  afterIdle?: Phones;
  idleStopAfterS?: number;
}

const results: Results = { agentPhone, userPhone, idleMs: IDLE_MS };

const home = mkdtempSync("/tmp/pe-");

const repo = join(home, "repo");

initRepo(repo);

// The Daemon keeps your HOME so Claude Code finds its sign-in; POLARIS_HOME stays throwaway.
const daemon = await startDaemon({
  home: join(home, "d"),
  benchHarness: false,
  userHome: homedir(),
  env: { POLARIS_SIMULATOR_IDLE_MS: String(IDLE_MS) },
});

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const shoot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(out, `${name}.png`) });
  step(`saved ${name}.png`);
};

const PROMPT = [
  `Use only the polaris_simulator tools. Call simulator_list, then simulator_open the iOS`,
  `Simulator named "${AGENT_NAME}" with the app com.apple.Preferences (Settings).`,
  `Take a simulator_snapshot, tap "General", snapshot again, tap "About", snapshot again,`,
  `and reply with the iOS version About shows. If the screen isn't what you expect (someone`,
  `else may press Home), open Settings again and carry on.`,
].join(" ");

type Phase = "dot" | "live" | "driving" | "done";

/**
 * One poll of the user's side while the agent works; it never blocks, so approvals keep flowing
 * (each Simulator tool call asks first in a Supervised session).
 */
const watchAgent = async (page: Page, phase: Phase): Promise<Phase> => {
  if (phase === "dot" && (await page.getByLabel("An agent opened a Simulator").count()) > 0) {
    step("the rail shows the agent's dot");
    await shoot(page, "dot");
    await page.getByTestId("output-rail-simulator").click();

    return "live";
  }

  const streaming =
    (await page.locator('[data-testid="simulator-live"] canvas').count()) > 0 &&
    (await page.getByTestId("simulator-bezel").count()) === 0;

  if (phase === "live" && streaming) {
    step("the stream is live");

    return "driving";
  }

  if (
    phase === "driving" &&
    streaming &&
    (await page.getByTestId("simulator-driving").count()) > 0
  ) {
    results.drivingStrip = await page.getByTestId("simulator-driving").innerText();
    await shoot(page, "agent-driving");
    // User input wins: Home while the agent drives goes through at once.
    const home = page.getByRole("button", { name: "Home" });
    results.homeEnabledWhileDriving = await home.isEnabled();
    await home.click();
    await page.waitForTimeout(2500);
    simctl("io", agentPhone, "screenshot", join(out, "simctl-after-user-home.png"));
    await shoot(page, "user-home-during-agent");

    return "done";
  }

  return phase;
};

/** Approves whatever the Turn asks until it is idle; returns how many. */
const runTurn = async (page: Page) => {
  const state = page.getByTestId("session-state");
  let approved = 0;
  let phase: Phase = "dot";

  for (let i = 0; i < 1200; i++) {
    if (i > 10 && ((await state.textContent()) ?? "").startsWith("Idle")) {
      results.lastPhase = phase;

      return approved;
    }

    const approve = page.getByTestId("approval").getByRole("button", { name: /^Approve/ });

    if ((await approve.count()) > 0) {
      await approve.first().click();
      approved++;
      step(`approved ${approved} (${phase})`);
    }

    phase = await watchAgent(page, phase);
    await page.waitForTimeout(250);
  }

  throw new Error("the agent's Turn never finished");
};

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "sim-e2e" } })`
  );
  await page
    .getByRole("button", { name: /sim-e2e/ })
    .first()
    .click();
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByTestId("harness-claude").click();
  await page.getByTestId("composer-input").fill(PROMPT);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("session-panel").waitFor({ timeout: 30_000 });
  step("Claude Code session started");

  // Close Output ourselves, so the agent's Simulator leaves a dot rather than coming forward.
  await page.getByRole("button", { name: "Show output" }).click();
  await page.getByRole("button", { name: "Hide output" }).click();
  await page.getByTestId("output-rail").waitFor();

  const approved = await runTurn(page);
  results.approvals = approved;
  assert.equal(results.lastPhase, "done", "the user saw the dot, the stream and the agent strip");
  await page.waitForTimeout(1500);
  await shoot(page, "agent-done");
  results.reply = (await page.getByTestId("session-panel").innerText()).slice(-1200);
  step("the agent's Turn finished");

  // Restart: the stream comes back.
  await page.getByTestId("simulator-restart").click();
  await page.getByTestId("simulator-reconnecting").waitFor({ timeout: 10_000 });
  await shoot(page, "restarting");
  await page.getByTestId("simulator-reconnecting").waitFor({ state: "detached", timeout: 120_000 });
  await page.locator('[data-testid="simulator-live"] canvas').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await shoot(page, "after-restart");
  step("Restart recovered");

  // Idle: hiding Output detaches; after the idle time only the agent's iPhone shuts down.
  await page.getByRole("button", { name: "Hide output" }).click();
  await page.getByTestId("output-rail").waitFor();
  results.beforeIdle = { agent: stateOf(agentPhone), user: stateOf(userPhone) };

  const deadline = Date.now() + IDLE_MS + 120_000;

  while (stateOf(agentPhone) !== "Shutdown" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 2000));

  results.afterIdle = { agent: stateOf(agentPhone), user: stateOf(userPhone) };
  results.idleStopAfterS = Number(
    ((Date.now() - (deadline - IDLE_MS - 120_000)) / 1000).toFixed(1)
  );
  step(`after idle: ${JSON.stringify(results.afterIdle)}`);
  assert.equal(stateOf(agentPhone), "Shutdown", "the agent's iPhone shuts down at idle");
  assert.equal(stateOf(userPhone), "Booted", "the user's iPhone stays booted");
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  await app.close().catch(() => undefined);
  await daemon.stop();

  for (const id of [agentPhone, userPhone]) {
    try {
      simctl("shutdown", id);
    } catch {
      // Already shut down.
    }

    simctl("delete", id);
  }

  rmSync(home, { recursive: true, force: true });
  step("deleted both throwaway Simulators");
}
