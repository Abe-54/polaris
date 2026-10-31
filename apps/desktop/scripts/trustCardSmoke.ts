/**
 * The Trust card in the real app on an isolated profile: node apps/desktop/scripts/trustCardSmoke.ts
 * (build first). Ask once, Not now across restarts, ask again, Trust, both themes.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import * as P from "@polaris/protocol";
import { Schema } from "effect";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-trust-card-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/trust-card");

const name = "trust-card-acceptance.ts";

const path = join(REPO_ROOT, name);

assert.equal(existsSync(path), false, "Never overwrite an existing file");

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

writeFileSync(path, "export const value: string = 123;\nexport const other = value;\n");

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const call = async <S extends Schema.ConstraintDecoder<unknown>>(
  page: Page,
  method: string,
  input: typeof Schema.JsonObject.Type,
  schema: S
): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema)(
    await page.evaluate(`(async () => {
  const result = await window.polaris.languages.request(${JSON.stringify(method)}, ${JSON.stringify({ hostKey: "local", ...input })});
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
})()`)
  );

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const launch = async () => {
  if (daemon === undefined) throw new Error("Daemon missing");
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });

  return page;
};

const quit = async () => {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit());
  app = undefined;
};

const card = (page: Page) => page.getByTestId("trust-card");

const openFile = async (page: Page) => {
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 15_000 });
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click({ timeout: 15_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 });
};

/** Discovery has answered once the language status leaves "Checking…"; the card would be up by then. */
const settled = async (page: Page) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const text = await page.evaluate<string>("document.body.textContent ?? ''");

    if (!text.includes("Checking language tooling")) break;
    await page.waitForTimeout(100);
  }

  await page.waitForTimeout(1500);
};

const Point = Schema.fromJsonString(Schema.Struct({ x: Schema.Number, y: Schema.Number }));

/** The middle of a character in the code, for the mouse. */
const point = async (page: Page, line: number, column: number) =>
  Schema.decodeUnknownSync(Point)(
    await page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelectorAll(".cm-content .cm-line")[${line}], NodeFilter.SHOW_TEXT);
    let left = ${column}; let node;
    while ((node = walker.nextNode())) { if (left < node.length) break; left -= node.length; }
    const range = document.createRange(); range.setStart(node, left); range.setEnd(node, left + 1);
    const r = range.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`)
  );

const text = (page: Page, selector: string) =>
  page.evaluate<string>(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent).join(" | ")`
  );

const until = async (
  what: string,
  check: () => Promise<boolean>,
  seen?: () => Promise<string>,
  ms = 90_000
) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`, { cause: await seen?.() });
};

/** Squiggle and its message, hover and go-to-definition, from the provider the label names. */
const languageFeatures = async (page: Page, label: string, shot: string) => {
  await until(
    `${label} ready`,
    async () =>
      (await text(page, '[data-testid="language-pill"]')) ===
      (label.endsWith("bundled") ? label : "TypeScript")
  );
  await until(
    `${label} diagnostic`,
    async () => (await page.locator(".cm-lintRange-error").count()) > 0
  );

  const error = await point(page, 0, 15);
  await page.mouse.move(error.x, error.y);
  await until(
    "diagnostic message",
    async () => {
      const shown = await text(page, ".cm-tooltip-lint");

      return (
        shown.includes("Type 'number' is not assignable to type 'string'") &&
        shown.includes(`${label} · `)
      );
    },
    () => text(page, ".cm-tooltip, .cm-lintRange")
  );
  await page.screenshot({ path: join(evidence, `${shot}-diagnostic.png`) });
  await page.mouse.move(5, 5);

  const use = await point(page, 1, 22);
  await page.mouse.move(use.x, use.y);
  await until("hover", async () => {
    const shown = await text(page, ".cm-tooltip");

    return shown.includes(label) && shown.includes("const value: string");
  });
  await page.screenshot({ path: join(evidence, `${shot}-hover.png`) });
  await page.mouse.move(5, 5);

  await page.mouse.click(use.x, use.y);
  await until("cursor on line 2", async () => (await text(page, "body")).includes("Ln 2,"));
  await page.keyboard.press("F12");
  await until("definition", async () => (await text(page, "body")).includes("Ln 1, Col 14"));
  await page.mouse.move(5, 5);
  await until("tooltips closed", async () => (await page.locator(".cm-tooltip").count()) === 0);
  console.log(`${label}: diagnostic with its message, hover and go-to-definition`);
};

const appearance = async (page: Page, theme: string, density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
  let page = await launch();
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "polaris" } })`
  );

  const workspaceId = Schema.decodeUnknownSync(P.WorkspaceId)(
    await page.evaluate(`new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error("Workspace snapshot deadline")); }, 20000);
    stop = window.polaris.subscribe("host", { hostKey: "local" }, { items: (items) => {
      const snapshot = items.find(item => item._tag === "Snapshot");
      const registered = items.filter(item => item._tag === "Event" && item.envelope.event._tag === "WorkspaceRegistered").map(item => item.envelope.event.workspace);
      const workspace = [...(snapshot?.workspaces ?? []), ...registered].find(workspace => workspace.path === ${JSON.stringify(REPO_ROOT)});
      if (workspace) { clearTimeout(timer); stop(); resolve(workspace.id); }
    } });
  })`)
  );

  const inspectInput = {
    checkout: P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: REPO_ROOT }),
    path,
  };

  await openFile(page);
  await card(page).waitFor({ timeout: 30_000 });
  assert.equal(await card(page).count(), 1);
  assert.equal(
    await card(page).getByRole("heading").textContent(),
    "Run polaris's own TypeScript?"
  );
  console.log("Card appears once on the first TS file");
  await languageFeatures(page, "TypeScript · bundled", "bundled-dark");

  for (const theme of ["dark", "light"]) {
    for (const density of ["calm", "balanced", "compact"]) {
      await appearance(page, theme, density);
      await page.screenshot({ path: join(evidence, `ask-${theme}-${density}.png`) });
    }
  }

  await appearance(page, "dark", "calm");
  await card(page).getByRole("button", { name: "Not now" }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate("document.activeElement?.textContent"),
    "Trust polaris",
    "Tab moves from Not now to Trust"
  );
  await page.screenshot({ path: join(evidence, "focus-trust-dark.png") });
  await page.keyboard.press("Escape");
  await card(page).waitFor({ state: "detached", timeout: 15_000 });
  let status = await call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus);
  assert.equal(status.trust.decision, "declined");
  console.log("Esc (Not now) declined and hid the card");

  await quit();
  await daemon.stop();
  daemon = await startDaemon({ home: profile, benchHarness: true });
  page = await launch();
  await openFile(page);
  await settled(page);
  assert.equal(await card(page).count(), 0, "Not now holds across app and Daemon restart");
  await page.screenshot({ path: join(evidence, "declined-after-restart-dark.png") });
  console.log("Card stays gone after restart");

  await page.evaluate(
    `window.__polarisTrust.change(${JSON.stringify({ hostKey: "local", ...inspectInput })}, "ask-again", ${status.trust.revision})`
  );
  await card(page).waitFor({ timeout: 15_000 });
  assert.equal(await card(page).count(), 1);
  status = await call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus);
  assert.equal(status.trust.decision, "undecided");
  console.log("Ask again brings the card back");

  await appearance(page, "light", "calm");
  await languageFeatures(page, "TypeScript · bundled", "bundled-light");
  await card(page).getByRole("button", { name: "Trust polaris" }).click();
  await card(page).waitFor({ state: "detached", timeout: 15_000 });
  status = await call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus);
  assert.equal(status.trust.decision, "trusted");
  assert.equal(status.provider, "project");
  assert.equal(status.wouldRun.typescriptVersion, "7.0.2");
  await languageFeatures(page, "TypeScript 7.0.2", "trusted-light");
  await appearance(page, "dark", "calm");
  await languageFeatures(page, "TypeScript 7.0.2", "trusted-dark");
  console.log("PASS: Trust hid the card; project TypeScript 7.0.2 serves the file");
} finally {
  await quit().catch(() => undefined);
  await daemon?.stop();
  rmSync(path, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
