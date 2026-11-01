/**
 * The project's own formatter in the real app on an isolated profile:
 * node apps/desktop/scripts/projectFormatterSmoke.ts (build first). In this repo, untrusted, ⌘S
 * leaves formatting alone and the language popover explains; trusted, ⌘S formats with the repo's
 * oxfmt on Polaris's private Node (the Daemon's PATH has no node), so the file passes
 * `oxfmt --check`. Trust is changed through the Daemon, as another Client would, and the popover
 * still follows. (formatOnSaveSmoke covers a repo with no formatter.)
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-project-formatter-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-4f");

const name = "project-formatter-smoke.ts";

const path = join(REPO_ROOT, name);

/** What the TypeScript server's formatter would write (`export { };`), which oxfmt rejects. */
const messy = "export { };\nexport const answer = {value:42}\n";

/** The Daemon's PATH without any directory holding a `node`: oxfmt must run on the private Node. */
const withoutNode = (process.env.PATH ?? "")
  .split(":")
  .filter((directory) => directory !== "" && !existsSync(join(directory, "node")))
  .join(":");

const oxfmtCheck = () =>
  spawnSync(join(REPO_ROOT, "node_modules/.bin/oxfmt"), ["--check", path], { cwd: REPO_ROOT })
    .status === 0;

assert.equal(existsSync(path), false, "Never overwrite a file");

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

writeFileSync(path, messy);

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

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

const popover = async (page: Page) => {
  if ((await page.getByTestId("language-popover").count()) === 0)
    await page.getByTestId("language-pill").click();
  await page.getByTestId("language-popover").waitFor({ timeout: 5_000 });

  return (await page.getByTestId("language-popover").textContent()) ?? "";
};

const closePopover = async (page: Page) => {
  if ((await page.getByTestId("language-popover").count()) > 0) await page.keyboard.press("Escape");
  await page.getByTestId("language-popover").waitFor({ state: "detached", timeout: 5_000 });
};

/** Types a line at the end and saves with ⌘S. */
const editAndSave = async (page: Page, line: string) => {
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(line);
  await page.keyboard.press("Meta+S");
};

try {
  daemon = await startDaemon({ home: profile, benchHarness: true, env: { PATH: withoutNode } });
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

  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click({ timeout: 15_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 });

  // Untrusted: Not now on the Trust card, then save. Nothing formats the file.
  await page.getByTestId("trust-card").waitFor({ timeout: 240_000 });
  await page.getByTestId("trust-card").getByRole("button", { name: "Not now" }).click();
  await until(
    "the TypeScript server",
    async () =>
      ["bundled", "ready"].includes(
        (await page.getByTestId("language-pill").getAttribute("data-kind")) ?? ""
      ),
    240_000
  );
  await editAndSave(page, "// untrusted\n");
  await until("the save", () => readFileSync(path, "utf8").includes("// untrusted"));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const untrusted = readFileSync(path, "utf8");

  assert.ok(untrusted.startsWith(messy), `Untrusted save formatted the file:\n${untrusted}`);
  console.log("Untrusted: ⌘S saved the text as typed");

  await until("the popover explains", async () =>
    (await popover(page)).includes("Formatting uses oxfmt once you trust polaris.")
  );
  await page.screenshot({ path: join(evidence, "untrusted-popover.png") });
  console.log("Untrusted: the popover says Formatting uses oxfmt once you trust polaris.");
  await closePopover(page);

  // Trusted: the repo's oxfmt formats on save.
  // Trust through the Daemon directly, as another Client would: the popover still follows.
  const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: REPO_ROOT });
  const inspect = { checkout, path };
  const status = await call(page, "languages.trust.inspect", inspect, P.LanguageTrustStatus);

  await call(
    page,
    "languages.trust.change",
    { ...inspect, action: "trust", expectedRevision: status.trust.revision },
    P.LanguageTrustStatus
  );
  await until(
    "the popover shows the project's formatter",
    async () => {
      const text = await popover(page);
      await closePopover(page);

      return text.includes("oxfmt") && !text.includes("once you trust");
    },
    240_000
  );
  await until("a formatted save", async () => {
    await editAndSave(page, "// trusted\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    return oxfmtCheck();
  });

  const trusted = readFileSync(path, "utf8");

  assert.ok(trusted.startsWith("export {};\n"), trusted);
  await page.screenshot({ path: join(evidence, "trusted-saved.png") });
  console.log(`Trusted: ⌘S formatted with oxfmt; oxfmt --check passes:\n${trusted}`);
  console.log("PASS: the project's formatter");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(path, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
