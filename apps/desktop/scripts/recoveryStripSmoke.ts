/**
 * Refactor recovery in the real app on an isolated profile: node apps/desktop/scripts/recoveryStripSmoke.ts
 * (build first). The owner's case: a one-file F2 rename in apps/daemon/src/main.ts, then ⌘S,
 * formats with oxfmt and shows no strip, also after a relaunch. Then a partial multi-file
 * outcome left by an earlier launch (persisted as a crash would leave it) shows the new strip.
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
import {
  encodeGroup,
  previewFingerprint,
  type DraftGroup,
} from "../src/renderer/features/editor/refactors/group.ts";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-recovery-strip-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/recovery-strip");

const main = join(REPO_ROOT, "apps/daemon/src/main.ts");

const original = readFileSync(main, "utf8");

const withoutNode = (process.env.PATH ?? "")
  .split(":")
  .filter((directory) => directory !== "" && !existsSync(join(directory, "node")))
  .join(":");

const oxfmtCheck = () =>
  spawnSync(join(REPO_ROOT, "node_modules/.bin/oxfmt"), ["--check", main], { cwd: REPO_ROOT })
    .status === 0;

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

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

const openMain = async (page: Page) => {
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 30_000 });
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill("daemon/src/main.ts");
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][title$="main.ts"]')
    .waitFor({ timeout: 20_000 });
};

const ready = (page: Page) =>
  page
    .locator('[data-testid="language-pill"]:is([data-kind="ready"], [data-kind="bundled"])')
    .waitFor({ timeout: 240_000 });

/** Clicks into `word` on the first line that starts with `prefix`. */
const clickWord = async (page: Page, prefix: string, word: string) => {
  const point = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Number, y: Schema.Number }))(
    await page.evaluate(`(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith(${JSON.stringify(prefix)}));
      let offset = line.textContent.indexOf(${JSON.stringify(word)}) + 1;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset >= node.textContent.length) { offset -= node.textContent.length; continue; }
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const box = range.getBoundingClientRect();
        return { x: box.left + 1, y: box.top + box.height / 2 };
      }
    })()`)
  );

  await page.mouse.click(point.x, point.y);
};

const stripCount = async (page: Page) =>
  (await page.getByTestId("refactor-recovery").count()) +
  (await page.getByText("Refactor recovery", { exact: true }).count());

try {
  daemon = await startDaemon({ home: profile, benchHarness: true, env: { PATH: withoutNode } });
  let page = await launch();

  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "polaris" } })`
  );
  await openMain(page);
  await page.getByTestId("trust-card").waitFor({ timeout: 240_000 });
  await page.getByTestId("trust-card").getByRole("button", { name: "Trust polaris" }).click();
  await ready(page);

  // The owner's steps: a one-file F2 rename, then a badly formatted edit, then ⌘S.
  await until("a rename that applies", async () => {
    await clickWord(page, "const [command", "command");
    await page.keyboard.press("F2");
    await page.getByTestId("rename-field").getByLabel("New name").fill("subcommand");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    return (await page.locator(".cm-content").first().innerText()).includes("const [subcommand");
  });
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nconst smoke = {a:1}\n");
  await page.keyboard.press("Meta+S");
  await until("the save formatted with oxfmt", () => {
    const text = readFileSync(main, "utf8");

    return (
      text.includes("const [subcommand") && text.includes("const smoke = { a: 1 };") && oxfmtCheck()
    );
  });
  await page.waitForTimeout(2000);
  assert.equal(await stripCount(page), 0, "No recovery strip after the save");
  await page.screenshot({ path: join(evidence, "saved-main-no-strip.png") });
  console.log("main.ts: ⌘S formatted with oxfmt (oxfmt --check passes); no recovery strip");

  // A relaunch purges what's left, so nothing resurfaces.
  await app?.evaluate(({ app: electronApp }) => electronApp.exit());
  page = await launch();
  await openMain(page);
  await ready(page);
  await page.waitForTimeout(3000);
  assert.equal(await stripCount(page), 0, "No recovery strip after a relaunch");
  console.log("Relaunch: no recovery strip");

  // A partial multi-file outcome from an earlier launch, persisted as a crash would leave it.
  const identity = await call(
    page,
    "languages.identity.get",
    {},
    Schema.Struct({ hostId: P.HostId, clientId: P.LanguageKey })
  );

  const workspaceId = Schema.decodeUnknownSync(P.WorkspaceId)(
    await page.evaluate(`new Promise((resolve, reject) => {
      let stop = () => {};
      const timer = setTimeout(() => { stop(); reject(new Error("Workspace deadline")); }, 20000);
      stop = window.polaris.subscribe("host", { hostKey: "local" }, { items: (items) => {
        const snapshot = items.find(item => item._tag === "Snapshot");
        const workspace = (snapshot?.workspaces ?? []).find(w => w.path === ${JSON.stringify(REPO_ROOT)});
        if (workspace) { clearTimeout(timer); stop(); resolve(workspace.id); }
      } });
    })`)
  );

  const files = [
    "apps/daemon/src/serve.ts",
    "apps/daemon/src/services.ts",
    "apps/daemon/src/debug.ts",
  ].map((path) => join(REPO_ROOT, path));

  const document = (path: string) => ({
    uri: `file://${path}`,
    canonicalPath: path,
    sourcePath: path,
    text: "x",
    dirty: false,
    diskText: "x",
    diskVersion: { mtimeMs: 1, size: 1, hash: "b".repeat(64) },
    version: 1,
    draftRevision: 0,
    buffer: { version: 1, draftRevision: 0, text: "x" },
  });

  const proposal = Schema.decodeUnknownSync(P.LanguageTreeEditProposal)({
    format: 2,
    proposalId: "smoke-proposal",
    origin: "rename",
    label: "Rename startServer to startDaemon",
    expiresAt: Date.now() + 60_000,
    fence: {
      context: {
        hostId: identity.hostId,
        clientId: identity.clientId,
        contextId: "smoke-context",
        checkout: P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: REPO_ROOT }),
        projectRoot: REPO_ROOT,
        providerId: "typescript-language-server",
        configurationFingerprint: "a".repeat(64),
        generation: 1,
      },
      requiredSequence: 0,
      documents: files.map((path) => ({ uri: `file://${path}`, version: 1 })),
    },
    edit: { changes: {} },
    snapshots: [],
    resourceSnapshots: [],
  });

  const group: DraftGroup = {
    format: 2,
    id: "smoke-partial",
    operationId: "smoke-operation",
    hostKey: "local",
    revision: 0,
    updatedAt: 1,
    fingerprint: await previewFingerprint(proposal),
    proposal,
    originals: files.map(document),
    documents: files.map(document),
    touched: files,
    state: "partial",
    outcome: null,
    message: "",
  };

  await page.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open("polaris-editor-refactors", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("groups");
    req.onsuccess = () => {
      const tx = req.result.transaction("groups", "readwrite");
      tx.objectStore("groups").put(${JSON.stringify(encodeGroup(group))}, "smoke-partial");
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  })`);
  await app?.evaluate(({ app: electronApp }) => electronApp.exit());
  page = await launch();
  await openMain(page);

  const strip = page.getByTestId("refactor-recovery");

  await strip.waitFor({ timeout: 60_000 }).catch(async (cause: unknown) => {
    const stored = await page.evaluate(`new Promise((resolve) => {
      const req = indexedDB.open("polaris-editor-refactors", 1);
      req.onsuccess = () => {
        const get = req.result.transaction("groups").objectStore("groups").getAllKeys();
        get.onsuccess = () => resolve(get.result);
      };
    })`);

    const now = await call(
      page,
      "languages.identity.get",
      {},
      Schema.Struct({ clientId: P.LanguageKey })
    );

    console.log(
      `stored: ${JSON.stringify(stored)}; seeded for ${identity.clientId}, now ${now.clientId}`
    );
    throw cause;
  });

  const text = (await strip.textContent()) ?? "";

  assert.ok(
    text.includes(
      "Rename startServer to startDaemon stopped partway through serve.ts, services.ts and 1 more."
    ),
    text
  );
  assert.equal(await strip.getByRole("button", { name: "Check again" }).count(), 1);
  assert.equal(await strip.getByRole("button", { name: "Undo" }).count(), 1);
  await page.evaluate(`document.documentElement.dataset.theme = "dark"`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidence, "partial-strip-dark.png") });
  await page.evaluate(`document.documentElement.dataset.theme = "light"`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidence, "partial-strip-light.png") });
  console.log(`Partial: ${text}`);
  console.log("PASS: refactor recovery");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  writeFileSync(main, original);
  rmSync(profile, { recursive: true, force: true });
}
