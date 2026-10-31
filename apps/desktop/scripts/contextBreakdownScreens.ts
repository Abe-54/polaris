#!/usr/bin/env node
/**
 * The Session context card's breakdown (Paper 11c) in the real app, on the bench Harness:
 * a Claude Code-shaped count opens to the conversation by kind, MCP servers, skills and
 * memory files; a total-only count says so. Both themes.
 *
 *   node scripts/contextBreakdownScreens.ts --out <dir> [--build]
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("usage: node scripts/contextBreakdownScreens.ts --out <dir>");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-context-breakdown-")));

const bench = (script: Record<string, number | boolean>) => `bench:${JSON.stringify(script)}`;

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

const shoot = async (page: Page, name: string, before: () => Promise<void>) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await before();
    // Let the card's fade-in finish.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await page.getByTestId("context-card").waitFor({ state: "detached" });
  }

  await appearance(page, "dark");
  console.log(`shot: ${name}`);
};

const idle = (page: Page) =>
  page.getByTestId("session-state").filter({ hasText: /^Idle/ }).waitFor({ timeout: 60_000 });

const send = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input");

  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await page.getByTestId("prompt").filter({ hasText: text }).first().waitFor();
  await idle(page);
};

const openSession = async (page: Page, title: string) => {
  await page.getByText(title, { exact: true }).first().click();
  await idle(page);
};

const openCard = async (page: Page) => {
  await page.mouse.move(0, 0);
  await page.getByTestId("session-context").click();
  await page.getByTestId("context-card").waitFor();
};

const row = (page: Page, key: string) =>
  page.locator(`[data-testid="context-row"][data-key="${key}"]`);

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: stockElectronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 900);
  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "proof",
        sessions: [
          { title: "Breakdown proof", state: "idle" },
          { title: "Totals proof", state: "idle" },
        ],
      },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "proof" }).first().click();

  // Four Turns: 120k of 200k, broken down as Claude Code counts it.
  await openSession(page, "Breakdown proof");

  for (const n of [1, 2, 3, 4])
    await send(page, bench({ items: 1, deltasPerItem: n, contextBreakdown: true }));

  await openCard(page);

  const labels = await page.getByTestId("context-row").locator(".text-body").allTextContents();

  console.log(`rows: ${labels.join(" | ")}`);
  assert.deepEqual(labels, [
    "Conversation",
    "Built-in tools",
    "MCP servers",
    "Skills",
    "Memory files",
    "System prompt and agents",
    "Free",
    "Kept free for auto-compact",
  ]);
  assert.equal(await page.getByTestId("context-details").count(), 0, "rows start closed");
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.getByTestId("context-card").waitFor({ state: "detached" });
  await shoot(page, "closed", () => openCard(page));

  const expand = async () => {
    await openCard(page);
    await row(page, "conversation").getByRole("button").click();
    await row(page, "mcp").getByRole("button").click();
    await row(page, "conversation").getByRole("button").hover();
  };

  await expand();

  const conversation = await row(page, "conversation").getByTestId("context-details").innerText();
  const mcp = await row(page, "mcp").getByTestId("context-details").innerText();

  console.log(`conversation:\n${conversation}\nmcp:\n${mcp}`);
  assert.ok(conversation.startsWith("Tool results"), "the largest kind first");
  assert.ok(mcp.includes("linear") && mcp.includes("4 of 76 tools"), "a server with its tools");
  assert.ok(mcp.includes("Server instructions") && mcp.includes("15 servers"));
  assert.ok(mcp.includes("13 more servers load their 628 tools on demand"));
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.getByTestId("context-card").waitFor({ state: "detached" });
  await shoot(page, "open", expand);

  const skillsAndMemory = async () => {
    await openCard(page);
    await row(page, "skills").getByRole("button").click();
    await row(page, "memory").getByRole("button").click();
  };

  await skillsAndMemory();

  const card = await page.getByTestId("context-card").boundingBox();
  const height = await page.evaluate<number>("window.innerHeight");

  assert.ok(card !== null && card.y + card.height <= height, "the open card stays in the window");

  const skills = await row(page, "skills").getByTestId("context-details").innerText();

  assert.ok(skills.includes("skill-1") && skills.includes("58 more"), "the top 20, then the rest");
  assert.ok(
    (await row(page, "memory").getByTestId("context-details").innerText()).includes("AGENTS.md")
  );
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.getByTestId("context-card").waitFor({ state: "detached" });
  await shoot(page, "skills-memory", skillsAndMemory);

  // A total-only count (as Codex gives) says so.
  await openSession(page, "Totals proof");
  await send(page, bench({ items: 1 }));
  await openCard(page);
  await page.getByText("reports the total only, not what fills it").waitFor();
  console.log("ok: total-only note");
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.getByTestId("context-card").waitFor({ state: "detached" });
  await shoot(page, "totals-only", () => openCard(page));
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
