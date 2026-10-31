/** Opt-in real Host acceptance: build linux-arm64 and Desktop, then run this with Node. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { Schema } from "effect";
import * as P from "@polaris/protocol";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const alias = "lucas-rpi";

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-6");

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-slice6-desktop-")));

const fixtureSchema = Schema.Struct({
  root: Schema.String,
  packages: Schema.Array(Schema.JsonObject),
});

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ConnectTimeout=15",
  alias,
];

const measurements: Record<string, typeof Schema.Json.Type> = {};

const timings: Record<string, number> = {};

const checks: string[] = [];

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

mkdirSync(evidence, { recursive: true });

writeFileSync(
  join(profile, "settings.json"),
  JSON.stringify({
    welcomeSeen: true,
    local: { enabled: false },
    hosts: [{ alias, label: alias }],
    keepDaemonsUpToDate: false,
  })
);

const remote = (command: string, input?: string) =>
  execFileSync("ssh", [...sshOptions, command], { encoding: "utf8", input, timeout: 120000 });

const python = (operation: "fixtures" | "sample") =>
  remote(
    `python3 - ${operation}`,
    readFileSync(join(APP_DIR, "scripts/lib/remoteLanguages.py"), "utf8")
  );

const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(fixtureSchema))(python("fixtures"));

assert.match(fixture.root, /^\/home\/lucasdoell\/\.polaris-slice6-[a-zA-Z0-9_-]+$/);

const archive = execFileSync("git", ["archive", "HEAD"], {
  cwd: REPO_ROOT,
  maxBuffer: 64 * 1024 * 1024,
});

execFileSync("ssh", [...sshOptions, `tar -xf - -C ${fixture.root}/repository`], {
  input: archive,
  timeout: 120000,
});

remote(`cp -a ${fixture.root}/repository/. ${fixture.root}/manual-repository/`);

measurements.repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();

const workspaceName = (name: string) => `slice6-${fixture.root.split("-").at(-1)}-${name}`;

function receipt(passed: boolean) {
  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify({ passed, alias, profile, fixture, checks, timings, measurements }, null, 2) +
      "\n"
  );
}

async function call<S extends Schema.ConstraintDecoder<unknown>>(
  page: Page,
  method: string,
  input: typeof Schema.JsonObject.Type,
  schema: S,
  language = false
): Promise<S["Type"]> {
  return Schema.decodeUnknownSync(schema)(
    await page.evaluate(`(async () => {
    const reply = await window.polaris${language ? ".languages" : ""}.request(${JSON.stringify(method)}, ${JSON.stringify({ hostKey: alias, ...input })});
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.value;
  })()`)
  );
}

async function launch() {
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_USER_DATA: profile,
      POLARIS_DESKTOP_HIDDEN: "1",
      POLARIS_DESKTOP_DAEMON_DIST: join(REPO_ROOT, "apps/daemon/dist"),
    },
  });
  const page = await app.firstWindow();
  await sizeWindow(app, 1280, 900);

  return page;
}

async function connected(page: Page) {
  await page.evaluate(`new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {stop(); reject(new Error("Host connection deadline"));}, 120000);
    stop = window.polaris.subscribe("machines", {}, {items: lists => {
      const machine = lists.at(-1)?.find(m => m.key === ${JSON.stringify(alias)});
      if (machine?.status?.state !== "connected") return;
      clearTimeout(timer); stop(); resolve();
    }});
  })`);
}

async function register(page: Page, root: string, name: string) {
  await call(
    page,
    "dispatch",
    {
      commandId: crypto.randomUUID(),
      command: P.Command.cases.RegisterWorkspace.make({ path: root, name }),
    },
    Schema.Json
  );

  const id = Schema.decodeUnknownSync(P.WorkspaceId)(
    await page.evaluate(`new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {stop(); reject(new Error("Workspace deadline"));}, 20000);
    stop = window.polaris.subscribe("host", {hostKey: ${JSON.stringify(alias)}}, {items: items => {
      const snapshot = items.find(item => item._tag === "Snapshot");
      const created = items.filter(item => item._tag === "Event" && item.envelope.event._tag === "WorkspaceRegistered").map(item => item.envelope.event.workspace);
      const workspace = [...(snapshot?.workspaces ?? []), ...created].find(w => w.path === ${JSON.stringify(root)});
      if (workspace) {clearTimeout(timer); stop(); resolve(workspace.id);}
    }});
  })`)
  );

  return P.LanguageCheckout.cases.Workspace.make({ workspaceId: id, path: root });
}

async function open(page: Page, name: string, file: string) {
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill(name);
  await page.getByTestId("jump-item").filter({ hasText: name }).first().click();
  await page.getByRole("radio", { name: "Edit", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 30000 });
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(file);
  await page.getByTestId("finder-item").filter({ hasText: file }).first().click({ timeout: 20000 });
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${file}"]`)
    .waitFor();
}

async function ready(page: Page, project = false) {
  await page
    .locator(
      project
        ? '[data-testid="language-pill"][data-kind="ready"]'
        : '[data-testid="language-pill"]:is([data-kind="ready"], [data-kind="bundled"], [data-kind="needs-trust"])'
    )
    .waitFor({ timeout: 240000 });
}

async function cursor(page: Page, line: number, offset: number) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+ArrowUp");

  for (let n = 0; n < line; n++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+ArrowLeft");

  for (let n = 0; n < offset; n++) await page.keyboard.press("ArrowRight");
}

async function hover(page: Page, line: number, offset: number, text: string) {
  await page.mouse.move(0, 0);

  const point = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Number, y: Schema.Number }))(
    await page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelectorAll('.cm-line')[${line}], NodeFilter.SHOW_TEXT);
    let offset = ${offset};
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset >= node.textContent.length) {offset -= node.textContent.length; continue;}
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const box = range.getBoundingClientRect(); return {x: box.x + box.width / 2, y: box.y + box.height / 2};
    }
  })()`)
  );

  await page.mouse.move(point.x, point.y);
  await page.locator(".cm-tooltip-hover").filter({ hasText: text }).waitFor({ timeout: 30000 });
}

async function features(page: Page, language: "ts" | "py", name: string) {
  const isPython = language === "py";
  const line = isPython ? 3 : 1;
  const offset = isPython ? 9 : 16;
  await hover(page, line, offset, isPython ? "int" : "42");
  await page.screenshot({ path: join(evidence, `${name}-hover.png`) });
  await cursor(page, line, offset);
  await page.keyboard.press("F12");
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="value.${language}"]`)
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(evidence, `${name}-definition.png`) });
  await page
    .getByTestId("editor-tab")
    .filter({ hasText: `proof.${language}` })
    .click();
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="proof.${language}"]`)
    .waitFor();
  await page.keyboard.press("Meta+Shift+M");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByText(/not assignable/).waitFor({ timeout: 30000 });

  if (isPython) {
    await problems.getByText(/imported but unused/).waitFor({ timeout: 30000 });
    assert.match(await problems.innerText(), /basedpyright/);
    assert.match(await problems.innerText(), /ruff/);
  }

  await page.screenshot({ path: join(evidence, `${name}-diagnostics.png`) });
  await cursor(page, line, offset);
  await page.keyboard.press("F2");
  const rename = page.getByTestId("rename-field").getByLabel("New name");

  await rename.fill("renamedAnswer");
  await rename.press("Enter");

  const accept = page
    .getByTestId("rename-preview")
    .getByRole("button", { name: "Rename in 2 files" });

  const changed = page.locator(".cm-content").filter({ hasText: "renamedAnswer" });

  const outcome = await Promise.race([
    accept.waitFor({ timeout: 30000 }).then(() => "preview"),
    changed.waitFor({ timeout: 30000 }).then(() => "draft"),
  ]);

  if (outcome === "preview") {
    await page.screenshot({ path: join(evidence, `${name}-rename-preview.png`) });
    await accept.click();
  }

  await changed.waitFor();
  await page.screenshot({ path: join(evidence, `${name}-rename.png`) });
  checks.push(`${name}: hover, diagnostics, definition, accepted rename`);
  receipt(false);
}

async function log(page: Page, name: string) {
  await page.getByTestId("language-pill").click();
  assert.match(await page.getByTestId("language-popover").innerText(), /lucas-rpi/);
  await page.screenshot({ path: join(evidence, `${name}-popover.png`) });
  await page.getByRole("menuitem", { name: "Show language server log" }).click();
  await page.getByTestId("language-log").waitFor();
  await page.waitForFunction(`() => {
    const view = document.querySelector('[data-testid="language-log"]');
    return view?.querySelector('[role="listitem"]') || view?.textContent?.includes("Nothing logged yet.");
  }`);
  writeFileSync(
    join(evidence, `${name}-log.txt`),
    await page.getByTestId("language-log").innerText()
  );
  await page.screenshot({ path: join(evidence, `${name}-log.png`) });
  await page
    .getByTestId("editor-tab")
    .filter({ hasText: name.startsWith("python") ? "proof.py" : "proof.ts" })
    .click();
  checks.push(`${name}: Host-labelled status and live log tab`);
}

async function sample(name: string) {
  await app?.firstWindow().then((page) => page.waitForTimeout(30000));
  measurements[name] = decodeJson(python("sample"));
  console.log(`${name}: ${JSON.stringify(measurements[name])}`);
  receipt(false);
}

async function looks(page: Page) {
  for (const theme of ["dark", "light"])
    for (const density of ["calm", "balanced", "compact"]) {
      await call(page, "settings.setAppearance", { patch: { theme, density } }, Schema.Json);
      await page
        .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
        .waitFor({ state: "attached" });
      await page.screenshot({ path: join(evidence, `settings-${theme}-${density}.png`) });
    }
}

try {
  receipt(false);
  let page = await launch();
  await connected(page);
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  await page.evaluate(`new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {stop(); reject(new Error("Initial Host check deadline"));}, 120000);
    stop = window.polaris.subscribe("machines", {}, {items: lists => {
      const machine = lists.at(-1)?.find(m => m.key === ${JSON.stringify(alias)});
      const daemon = machine?.daemon;
      if (!daemon?.installedVersion || !daemon.bundledVersion || machine.install?.activity) return;
      if (daemon.progress && !["done", "failed"].includes(daemon.progress.stage)) return;
      clearTimeout(timer); stop(); resolve();
    }});
  })`);
  const beforePid = remote("cat ~/.polaris/daemon.pid").trim();
  const updateStarted = Date.now();

  await call(page, "machines.updateDaemon", {}, Schema.Json);
  await page.evaluate(`new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {stop(); reject(new Error("Upgrade receipt deadline"));}, 600000);
    stop = window.polaris.subscribe("machines", {}, {items: lists => {
      const machine = lists.at(-1)?.find(m => m.key === ${JSON.stringify(alias)});
      const result = machine?.daemon?.lastUpdate;
      if (!result || result.at < ${updateStarted}) return;
      if (result.result === "failed") {clearTimeout(timer); stop(); reject(new Error(JSON.stringify(result))); return;}
      clearTimeout(timer); stop(); resolve(result);
    }});
  })`);
  await page.keyboard.press("Escape");
  await connected(page);
  assert.equal(
    remote("cat ~/.polaris/daemon.pid").trim(),
    beforePid,
    "Daemon Upgrade keeps its PID"
  );
  const version = remote("~/.polaris/bin/current/polaris version").trim();

  const manifest = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
  )(readFileSync(join(REPO_ROOT, "apps/daemon/dist/manifest.json"), "utf8"));

  assert.match(version, new RegExp(manifest.version.replaceAll(".", "\\.")));
  measurements.version = version;
  await page.screenshot({ path: join(evidence, "host-upgraded.png") });
  checks.push("Desktop App verified real linux-arm64 Daemon through its SSH update path");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(30000);
  await sample("idle-no-files");

  const fresh = await register(page, `${fixture.root}/fresh`, workspaceName("fresh"));
  const project = await register(page, `${fixture.root}/project`, workspaceName("project"));
  await register(page, `${fixture.root}/python`, workspaceName("python"));
  const started = Date.now();
  await open(page, workspaceName("fresh"), "proof.ts");
  console.log(`First pill: ${await page.getByTestId("language-pill").innerText()}`);
  await ready(page);
  timings.firstTsReadyIncludingDownloadsMs = Date.now() - started;
  await hover(page, 1, 16, "42");
  timings.firstTsHoverIncludingDownloadsMs = Date.now() - started;
  assert.equal(await page.getByTestId("trust-card").count(), 0);
  await sample("bundled-ts-open");

  const managed = remote("ps -eo args")
    .split("\n")
    .find((line) => line.includes("lib/tsc --lsp --stdio"));

  assert.ok(
    managed?.includes("/home/lucasdoell/.polaris/languages/"),
    "Managed TS runs TypeScript 7 from the Host's languages"
  );
  measurements.managedCommand = managed ?? "";
  await features(page, "ts", "fresh-ts");
  await log(page, "fresh-ts");
  assert.equal(
    (
      await call(
        page,
        "languages.trust.inspect",
        { checkout: fresh, path: `${fixture.root}/fresh/proof.ts` },
        P.LanguageTrustStatus,
        true
      )
    ).trust.decision,
    "undecided"
  );

  await open(page, workspaceName("project"), "proof.ts");
  const card = page.getByTestId("trust-card");
  await card.waitFor({ timeout: 60000 });
  assert.match(await card.innerText(), /7\.0\.2/);
  assert.match(await card.innerText(), /lucas-rpi/);
  await page.screenshot({ path: join(evidence, "trust-card.png") });
  await card.getByRole("button", { name: "Not now" }).click();
  await ready(page);
  await app?.evaluate(({ app: electronApp }) => electronApp.exit());
  page = await launch();
  await connected(page);
  await open(page, workspaceName("project"), "proof.ts");
  await ready(page);
  const input = { checkout: project, path: `${fixture.root}/project/proof.ts` };
  const declined = await call(page, "languages.trust.inspect", input, P.LanguageTrustStatus, true);
  assert.equal(declined.trust.decision, "declined");
  assert.equal(declined.ask, false);
  assert.equal(await page.getByTestId("trust-card").count(), 0);
  await call(
    page,
    "languages.trust.change",
    { ...input, action: "ask-again", expectedRevision: declined.trust.revision },
    P.LanguageTrustStatus,
    true
  );
  const again = await call(page, "languages.trust.inspect", input, P.LanguageTrustStatus, true);
  await call(
    page,
    "languages.trust.change",
    { ...input, action: "trust", expectedRevision: again.trust.revision },
    P.LanguageTrustStatus,
    true
  );
  await ready(page, true);
  const trusted = await call(page, "languages.trust.inspect", input, P.LanguageTrustStatus, true);
  assert.equal(trusted.provider, "project");
  assert.equal(trusted.wouldRun.native, true);
  const native = remote("ps -eo args");
  assert.ok(
    native.includes(
      `${fixture.root}/project/node_modules/@typescript/typescript-linux-arm64/lib/tsc --lsp --stdio`
    )
  );
  measurements.nativeCommand =
    native
      .split("\n")
      .find((line) =>
        line.includes(
          `${fixture.root}/project/node_modules/@typescript/typescript-linux-arm64/lib/tsc`
        )
      ) ?? "";
  await features(page, "ts", "project-ts7");
  checks.push("Trust card and decline survive Client restart; Trust runs project native TS7");
  await log(page, "project-ts7");
  await sample("native-ts7-open");

  const pythonStarted = Date.now();
  await open(page, workspaceName("python"), "proof.py");
  await ready(page, true);
  timings.firstPythonReadyIncludingDownloadsMs = Date.now() - pythonStarted;
  await features(page, "py", "python-venv");
  await log(page, "python-venv");
  await page.locator(".cm-content").focus();
  await page.locator('[data-testid="editor-tab"][aria-selected="true"][data-dirty]').waitFor();
  await page.keyboard.press("Meta+s");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"]:not([data-dirty])')
    .waitFor({ timeout: 30000 });
  const saved = remote(`cat ${fixture.root}/python/proof.py`);
  assert.match(saved, /result = renamedAnswer\(\)/);
  checks.push("Ruff formats on save on the Pi using its existing Python venv");

  await register(page, `${fixture.root}/repository`, workspaceName("repository"));
  await open(page, workspaceName("repository"), "proof.ts");
  await ready(page);
  await features(page, "ts", "repository-ts");
  await open(page, workspaceName("repository"), "proof.py");
  await ready(page, true);
  await features(page, "py", "repository-python");

  const host = await call(
    page,
    "languages.host.state",
    { toolIds: [], refresh: true },
    P.LanguageHostState,
    true
  );

  measurements.hostState = Schema.encodeSync(P.LanguageHostState)(host);
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await page.getByRole("button", { name: `Host: ${alias}`, exact: true }).waitFor();
  await page.getByRole("switch", { name: "Python language tools" }).waitFor({ timeout: 30000 });
  await page.getByRole("switch", { name: "TypeScript and JavaScript language tools" }).waitFor();
  await looks(page);
  checks.push("Settings Languages rows belong to lucas-rpi in both themes and all densities");

  await call(
    page,
    "settings.setAppearance",
    { patch: { theme: "dark", density: "balanced" } },
    Schema.Json
  );
  await page.keyboard.press("Escape");

  for (const name of ["fresh", "project", "python", "repository"])
    await register(page, `${fixture.root}/manual-${name}`, workspaceName(`manual-${name}`));
  receipt(true);
  console.log(`PASS: ${join(evidence, "desktop.json")}`);
} catch (cause) {
  const page = await app?.firstWindow();

  if (page) {
    writeFileSync(
      join(evidence, "failure-before-popover.txt"),
      await page.locator("body").innerText()
    );

    if ((await page.getByTestId("language-pill").count()) > 0)
      await page
        .getByTestId("language-pill")
        .click()
        .catch(() => undefined);
    await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => undefined);
    writeFileSync(
      join(evidence, "failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Window closed")
    );
  }

  receipt(false);
  throw cause;
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
}
