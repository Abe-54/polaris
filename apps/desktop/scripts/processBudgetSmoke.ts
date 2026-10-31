/** All slice7 files held open together in an isolated real Desktop App. Build first. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Page } from "playwright-core";
import * as P from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";
import { takeScriptLease } from "../../../tooling/leases.ts";

await takeScriptLease("smoke");

const project = realpathSync(
  process.env.POLARIS_BUDGET_FIXTURE ?? "/Users/lucasdoell/code/lang-v2-fixtures/slice7"
);

const home = realpathSync(
  process.env.POLARIS_SMOKE_HOME ?? mkdtempSync(join(tmpdir(), "polaris-budget-desktop-"))
);

const userData = mkdtempSync(join(home, "desktop-profile-"));

const evidence = join(REPO_ROOT, ".dagr/evidence/process-budget");

const fixtures = [
  { path: "package.json", providers: ["vscode-json-language-server"] },
  { path: "tsconfig.json", providers: ["vscode-json-language-server"] },
  { path: "notes.json", providers: ["vscode-json-language-server"] },
  { path: "src/styles.css", providers: ["vscode-css-language-server"] },
  { path: "src/theme.scss", providers: ["vscode-css-language-server"] },
  { path: "src/index.html", providers: ["vscode-html-language-server"] },
  { path: "config.yaml", providers: ["yaml-language-server"] },
  {
    path: ".github/workflows/ci.yml",
    providers: ["yaml-language-server", "actions-language-server"],
  },
  { path: "prisma/schema.prisma", providers: ["prisma-language-server"] },
  { path: "src/Counter.svelte", providers: ["svelte-language-server"] },
  { path: "db/queries.sql", providers: ["sqllens-language-server"] },
  { path: "db/report.mysql.sql", providers: ["sqllens-language-server"] },
  { path: "db/sqlite.sql", providers: ["sqllens-language-server"] },
  { path: "scripts/deploy.sh", providers: ["bash-language-server"] },
];

const proofs = [
  {
    path: "src/process-budget-proof.ts",
    providers: ["typescript-language-server"],
    text: "export const value: number = 1;\nvalue.toFixed();\n",
  },
  {
    path: "src/process-budget-proof.py",
    providers: ["basedpyright", "ruff"],
    text: "from pathlib import Path\nvalue: int = 1\nprint(Path.cwd(), value)\n",
  },
];

const digest = (path: string) =>
  createHash("sha256")
    .update(readFileSync(join(project, path)))
    .digest("hex");

const originals = new Map(fixtures.map(({ path }) => [path, digest(path)]));

const created: string[] = [];

mkdirSync(evidence, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

async function call<S extends Schema.ConstraintDecoder<unknown>>(
  page: Page,
  method: string,
  input: typeof Schema.JsonObject.Type,
  schema: S
): Promise<S["Type"]> {
  return Schema.decodeUnknownSync(schema)(
    await page.evaluate(`(async () => {
    const answer = await window.polaris.languages.request(${JSON.stringify(method)}, ${JSON.stringify({ hostKey: "local", ...input })});
    if (!answer.ok) throw new Error(JSON.stringify(answer.error)); return answer.value;
  })()`)
  );
}

async function open(page: Page, path: string) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+3");

  if (path.startsWith(".github/")) {
    const folder = page
      .locator('[data-testid="tree-row"][data-kind="folder"]')
      .filter({ hasText: ".github" })
      .first();

    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
    await page.locator(`[data-testid="tree-row"][data-path="${join(project, path)}"]`).click();
  } else {
    await page.keyboard.press("Meta+P");
    await page.getByTestId("finder-input").fill(path);
    await page.getByTestId("finder-item").first().waitFor({ timeout: 20000 });
    await page.keyboard.press("Enter");
  }

  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${path.split("/").pop()}"]`)
    .waitFor();
  await page
    .locator(
      '[data-testid="language-pill"][data-kind="ready"], [data-testid="language-pill"][data-kind="bundled"]'
    )
    .waitFor({ timeout: 180000 });
}

async function register(page: Page) {
  return Schema.decodeUnknownSync(P.WorkspaceId)(
    await page.evaluate(`new Promise(async (resolve,reject) => {
    let stop=()=>{}; const timer=setTimeout(()=>{stop();reject(new Error('Workspace deadline'));},20000);
    stop=window.polaris.subscribe('host',{hostKey:'local'},{items:items=>{
      const snapshot=items.find(item=>item._tag==='Snapshot');
      const added=items.filter(item=>item._tag==='Event' && item.envelope.event._tag==='WorkspaceRegistered').map(item=>item.envelope.event.workspace);
      const workspace=[...(snapshot?.workspaces ?? []),...added].find(workspace=>workspace.path===${JSON.stringify(project)});
      if(workspace){clearTimeout(timer);stop();resolve(workspace.id);}
    }});
    const answer=await window.polaris.request('dispatch',{hostKey:'local',commandId:crypto.randomUUID(),command:{_tag:'RegisterWorkspace',path:${JSON.stringify(project)},name:'process-budget-proof'}});
    if(!answer.ok){clearTimeout(timer);stop();reject(new Error(JSON.stringify(answer.error)));}
  })`)
  );
}

const proofSettings = P.LanguageEffectiveSettings.make({
  revision: 0,
  formatOnSave: true,
  formatter: P.LanguageFormatterSelection.cases.None.make({}),
  providers: [],
  settings: {},
  origins: {},
});

async function readContext(
  page: Page,
  checkout: P.LanguageCheckout,
  snapshot: typeof P.LanguageContextSnapshot.Type
) {
  const uri = snapshot.ack.documents[0]?.uri;
  assert(uri, "Missing renderer-owned document");

  return call(
    page,
    "languages.context.acquire",
    {
      clientId: snapshot.context.clientId,
      contextId: snapshot.context.contextId,
      checkout,
      path: fileURLToPath(uri),
      providerId: snapshot.context.providerId,
      settings: proofSettings,
      interestId: "budget-proof",
    },
    P.LanguageContextSnapshot
  );
}

async function inventory(page: Page, checkout: P.LanguageCheckout) {
  const contexts: (typeof P.LanguageContextSnapshot.Type)[] = [];
  const providers = [...new Set([...fixtures, ...proofs].flatMap((item) => item.providers))];

  for (const providerId of providers) {
    const restarted = await call(
      page,
      "languages.server.restart",
      { checkout, providerId },
      Schema.Array(P.LanguageContextSnapshot)
    );

    assert(restarted.length > 0, `Missing ${providerId}`);

    for (let snapshot of restarted) {
      const deadline = Date.now() + 180000;

      while (!Predicate.isTagged(snapshot.runtime, "Ready") && Date.now() < deadline) {
        assert(!Predicate.isTagged(snapshot.runtime, "Failed"), JSON.stringify(snapshot.runtime));
        await page.waitForTimeout(100);
        snapshot = await readContext(page, checkout, snapshot);
      }

      assert(Predicate.isTagged(snapshot.runtime, "Ready"), JSON.stringify(snapshot.runtime));
      contexts.push(snapshot);
    }
  }

  const final: (typeof P.LanguageContextSnapshot.Type)[] = [];

  for (const snapshot of contexts) final.push(await readContext(page, checkout, snapshot));

  for (const snapshot of final)
    assert(Predicate.isTagged(snapshot.runtime, "Ready"), JSON.stringify(snapshot));

  for (const fixture of [...fixtures, ...proofs])
    for (const provider of fixture.providers)
      assert(
        final.some(
          (snapshot) =>
            snapshot.context.providerId === provider &&
            snapshot.ack.documents.some(
              (document) => document.uri === pathToFileURL(join(project, fixture.path)).href
            )
        ),
        `${fixture.path} missing from ${provider}`
      );

  return final;
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  for (const proof of proofs) {
    const path = join(project, proof.path);
    writeFileSync(path, proof.text, { flag: "wx" });
    created.push(path);
  }

  daemon = await startDaemon({ home, benchHarness: true });
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
  await sizeWindow(app, 1440, 1000);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20000 });

  const budget = await call(
    page,
    "languages.host.processBudget.get",
    {},
    P.LanguageHostProcessBudget
  );

  assert.equal(budget.maxProcesses, null, "Smoke must use automatic capacity");
  console.log("Automatic Host budget", JSON.stringify(budget));
  const workspaceId = await register(page);
  await page
    .getByRole("button", { name: /process-budget-proof/ })
    .first()
    .click();
  const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });

  for (const fixture of [...fixtures, ...proofs]) {
    console.log("Opening", fixture.path);
    await open(page, fixture.path);
  }

  const tabs = await page.getByTestId("editor-tab").count();
  assert.equal(tabs, fixtures.length + proofs.length);
  const contexts = await inventory(page, checkout);
  assert(contexts.length <= budget.effectiveLimit);
  await page.screenshot({ path: join(evidence, "all-files-open.png") });

  for (const [path, expected] of originals) assert.equal(digest(path), expected, `${path} changed`);

  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify(
      {
        passed: true,
        project,
        home,
        budget,
        tabs,
        contexts,
        originalFilesUnchanged: true,
        temporaryProofFiles: proofs.map(({ path }) => path),
      },
      null,
      2
    ) + "\n"
  );
  console.log("PASS", tabs, "open files;", contexts.length, "simultaneously Ready contexts");
} catch (cause) {
  const page = await app?.firstWindow();

  if (page) {
    await page.screenshot({ path: join(evidence, "desktop-failure.png") });
    writeFileSync(join(evidence, "desktop-failure.txt"), await page.locator("body").innerText());
  }

  throw cause;
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();

  for (const path of created) rmSync(path);

  for (const [path, expected] of originals) assert.equal(digest(path), expected, `${path} changed`);
}
