/** Real isolated Electron acceptance: node apps/desktop/scripts/rustLuaLanguageSmoke.ts (build first). */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Page } from "playwright-core";
import * as P from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { localHost, remoteHost, type SmokeHost } from "./lib/rustLuaHost.ts";
import { seenUserData } from "./lib/userData.ts";
import { assertStatusBarShown, longFile } from "./lib/statusBar.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const home = realpathSync(
  process.env.POLARIS_SMOKE_HOME ?? mkdtempSync(join(tmpdir(), "polaris-rust-lua-desktop-"))
);

const userData = seenUserData(join(home, "user-data"));

const remote = process.env.POLARIS_SMOKE_REMOTE;

const host = remote === undefined ? localHost(home) : remoteHost(remote, home, "linux-arm64");

const project = host.project;

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-8a", remote ?? "local");

/** Anything in the crate that runs leaves one of these. */
const markers = ["MARK_BUILD_RS", "MARK_RA_TOML", "MARK_RA_TOML_BS", "MARK_WRAPPER", "MARK_PLUGIN"];

const marked = () => markers.filter((name) => host.exists(name));

const put = host.put;

const RUST = `fn main() {\n    let total = util::add(1, 2);\n    let wrong: i32 = "text";\n    let v: Vec<i32> = Vec::new();\n    v.len();\n    println!("{}", total);\n}\n`;

const LUA = `---Greets someone.\n---@param name string\n---@return string\nlocal function greet(name)\n  return "hi " .. name\nend\n\nlocal msg = greet("a")\nprint(undefinedThing, msg)\n`;

const fixtures = [
  {
    path: "src/main.rs",
    provider: "rust-analyzer",
    text: RUST,
    hover: { line: 1, character: 23 },
    completion: { line: 4, character: 6 },
    diagnostic: /expected i32, found/i,
    unformatted: "fn   spare( )  {}\n",
    formatted: (text: string) => text.includes("fn spare() {}"),
  },
  {
    path: "main.lua",
    provider: "lua-language-server",
    text: LUA,
    hover: { line: 7, character: 13 },
    completion: { line: 8, character: 0 },
    diagnostic: /undefined global/i,
    unformatted: "local   spare  =  1\n",
    formatted: (text: string) => text.includes("local spare = 1"),
  },
] as const;

mkdirSync(evidence, { recursive: true });

put(
  "Cargo.toml",
  '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\nbuild = "build.rs"\n\n[dependencies]\nutil = { path = "util" }\n'
);

put(
  "build.rs",
  `fn main() { std::fs::write(${JSON.stringify(join(project, "MARK_BUILD_RS"))}, "x").unwrap(); }\n`
);

put(
  "rust-analyzer.toml",
  `[check]\noverrideCommand = ["sh", "-c", "touch ${project}/MARK_RA_TOML; echo"]\n[cargo.buildScripts]\noverrideCommand = ["sh", "-c", "touch ${project}/MARK_RA_TOML_BS; echo"]\n`
);

put(".cargo/config.toml", `[build]\nrustc-wrapper = "${project}/wrap.sh"\n`);

put("wrap.sh", `#!/bin/sh\ntouch ${project}/MARK_WRAPPER\nexec "$@"\n`, 0o755);

put("util/Cargo.toml", '[package]\nname = "util"\nversion = "0.1.0"\nedition = "2021"\n');

put(
  "util/src/lib.rs",
  "/// Adds two numbers.\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n"
);

put(".luarc.json", JSON.stringify({ "runtime.plugin": "plugin.lua" }));

put(
  "plugin.lua",
  `local f = io.open(${JSON.stringify(join(project, "MARK_PLUGIN"))}, "w") if f then f:write("x") f:close() end\n`
);

for (const fixture of fixtures) put(fixture.path, fixture.text);

put(
  "long.lua",
  longFile((index) => `local value${index} = ${index}`)
);

const call = async <S extends Schema.ConstraintDecoder<unknown>>(
  page: Page,
  method: string,
  input: typeof Schema.JsonObject.Type,
  schema: S
): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema)(
    await page.evaluate(`(async () => {
    const answer = await window.polaris.languages.request(${JSON.stringify(method)}, ${JSON.stringify({ hostKey: "local", ...input })});
    if (!answer.ok) throw new Error(JSON.stringify(answer.error)); return answer.value;
  })()`)
  );

async function open(page: Page, path: string) {
  await page.keyboard.press("Meta+3");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(path);
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"]')
    .filter({ hasText: path.split("/").pop() ?? path })
    .waitFor();
  await page
    .locator(
      '[data-testid="language-pill"][data-kind="ready"], [data-testid="language-pill"][data-kind="unavailable"], [data-testid="language-pill"][data-kind="stopped"], [data-testid="language-pill"][data-kind="crashed"]'
    )
    .waitFor({ timeout: 300000 });
  const unavailable = page.locator('[data-testid="language-pill"][data-kind="unavailable"]');

  if (await unavailable.isVisible()) {
    await unavailable.click();
    throw new Error(await page.locator("body").innerText());
  }
}

const proofSettings = P.LanguageEffectiveSettings.make({
  revision: 0,
  formatOnSave: true,
  formatter: P.LanguageFormatterSelection.cases.None.make({}),
  providers: [],
  settings: {},
  origins: {},
});

async function ready(
  page: Page,
  checkout: P.LanguageCheckout,
  fixture: (typeof fixtures)[number],
  context: P.LanguageContextIdentity
) {
  const input = {
    clientId: context.clientId,
    contextId: context.contextId,
    checkout,
    path: join(project, fixture.path),
    providerId: fixture.provider,
    settings: proofSettings,
    interestId: "proof",
  };

  let snapshot = await call(page, "languages.context.acquire", input, P.LanguageContextSnapshot);
  const deadline = Date.now() + 300000;

  while (
    Date.now() < deadline &&
    !(
      Predicate.isTagged(snapshot.runtime, "Ready") &&
      snapshot.runtime.capabilities.methods.includes("textDocument/hover")
    )
  ) {
    if (Predicate.isTagged(snapshot.runtime, "Failed"))
      throw new Error(JSON.stringify(snapshot.runtime));
    await page.waitForTimeout(100);
    snapshot = await call(page, "languages.context.acquire", input, P.LanguageContextSnapshot);
  }

  assert(Predicate.isTagged(snapshot.runtime, "Ready"), JSON.stringify(snapshot.runtime));

  return snapshot;
}

/** Retries while a server restarted by Trust rejects requests. */
const request = async (
  page: Page,
  snapshot: typeof P.LanguageContextSnapshot.Type,
  path: string,
  method: string,
  position: { line: number; character: number }
) => {
  for (let attempt = 0; ; attempt++)
    try {
      return await requestOnce(page, snapshot, path, method, position);
    } catch (cause) {
      if (attempt >= 60) throw cause;
      await page.waitForTimeout(1000);
    }
};

const requestOnce = (
  page: Page,
  snapshot: typeof P.LanguageContextSnapshot.Type,
  path: string,
  method: string,
  position: { line: number; character: number }
) =>
  call(
    page,
    "languages.request",
    {
      requestId: crypto.randomUUID(),
      fence: {
        context: snapshot.context,
        requiredSequence: snapshot.ack.acceptedSequence,
        documents: snapshot.ack.documents,
      },
      method,
      params: {
        textDocument: { uri: pathToFileURL(join(project, path)).href },
        position,
      },
      deadline: Date.now() + 30000,
    },
    P.LanguageFeatureResult
  );

/** Hover, then retries while the server is still indexing. */
async function features(
  page: Page,
  snapshot: typeof P.LanguageContextSnapshot.Type,
  fixture: (typeof fixtures)[number]
) {
  let hover = await request(page, snapshot, fixture.path, "textDocument/hover", fixture.hover);

  for (let attempt = 0; attempt < 120 && hover.result === null; attempt++) {
    await page.waitForTimeout(500);
    hover = await request(page, snapshot, fixture.path, "textDocument/hover", fixture.hover);
  }

  assert.notEqual(hover.result, null, `Missing ${fixture.path} hover`);

  const definition = await request(
    page,
    snapshot,
    fixture.path,
    "textDocument/definition",
    fixture.hover
  );

  const completion = await request(
    page,
    snapshot,
    fixture.path,
    "textDocument/completion",
    fixture.completion
  );

  assert.notDeepEqual(definition.result, [], `Missing ${fixture.path} definition`);
  assert.notEqual(definition.result, null, `Missing ${fixture.path} definition`);
  assert.notEqual(completion.result, null, `Missing ${fixture.path} completion`);

  return { hover: hover.result, definition: definition.result, completion: completion.result };
}

async function problems(page: Page, fixture: (typeof fixtures)[number], name: string) {
  const region = page.getByRole("region", { name: "Problems" });

  for (let attempt = 0; attempt < 60; attempt++) {
    if (await region.isVisible())
      await region.getByRole("button", { name: "Close", exact: true }).click();
    await page.keyboard.press("Meta+Shift+M");
    await page.waitForTimeout(500);

    if (await region.getByText(fixture.diagnostic).first().isVisible()) break;
  }

  await region.getByText(fixture.diagnostic).first().waitFor({ timeout: 1000 });
  await page.screenshot({ path: join(evidence, `${name}-diagnostics.png`) });
  await region.getByRole("button", { name: "Close", exact: true }).click();
}

/** Types an unformatted line at the end, saves, and waits for the server's format on disk. */
async function formatOnSave(page: Page, fixture: (typeof fixtures)[number]) {
  await page.locator(".cm-content[contenteditable=true]").last().click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(fixture.unformatted);
  await page.keyboard.press("Meta+S");
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline && !fixture.formatted(host.read(fixture.path)))
    await page.waitForTimeout(200);

  assert(
    fixture.formatted(host.read(fixture.path)),
    `${fixture.path} was not formatted on save:\n${host.read(fixture.path)}`
  );
}

/** Resident memory of each server process started from the isolated install. */
const rss = () =>
  Object.fromEntries(
    host
      .processes()
      .filter((line) => /rust-analyzer|lua-language-server/.test(line))
      .map((line) => {
        const [, kb, ...command] = line.trim().split(/\s+/);

        return [
          command.join(" ").includes("rust-analyzer") ? "rust-analyzer" : "lua-language-server",
          `${Math.round(Number(kb) / 1024)} MB`,
        ];
      })
  );

let daemon: Awaited<ReturnType<SmokeHost["start"]>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await host.start();
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
  await sizeWindow(app, 1280, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20000 });

  const workspaceId = Schema.decodeUnknownSync(P.WorkspaceId)(
    await page.evaluate(`new Promise(async (resolve,reject) => {
    let stop=()=>{}; const timer=setTimeout(()=>{stop();reject(new Error('Workspace deadline'));},20000);
    stop=window.polaris.subscribe('host',{hostKey:'local'},{items:items=>{
      const snapshot=items.find(item=>item._tag==='Snapshot');
      const registrations=items.filter(item=>item._tag==='Event' && item.envelope.event._tag==='WorkspaceRegistered').map(item=>item.envelope.event.workspace);
      const workspace=[...(snapshot?.workspaces ?? []),...registrations].find(workspace=>workspace.path===${JSON.stringify(project)});
      if(workspace){clearTimeout(timer);stop();resolve(workspace.id);}
    }});
    await window.polaris.request("dispatch", {hostKey:"local",commandId:crypto.randomUUID(),command:{_tag:"RegisterWorkspace",path:${JSON.stringify(project)},name:"rust-lua-proof"}});
  })`)
  );

  await page
    .getByRole("button", { name: /rust-lua-proof/ })
    .first()
    .click();
  const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });
  const contexts = new Map<string, P.LanguageContextIdentity>();
  const before: Record<string, Awaited<ReturnType<typeof features>>> = {};

  for (const fixture of fixtures) {
    console.log("Opening", fixture.path);
    await open(page, fixture.path);

    const [restarted] = await call(
      page,
      "languages.server.restart",
      { checkout, providerId: fixture.provider },
      Schema.Array(P.LanguageContextSnapshot)
    );

    assert(restarted !== undefined, "Missing renderer-owned context");
    const snapshot = await ready(page, checkout, fixture, restarted.context);

    contexts.set(fixture.provider, snapshot.context);
    before[fixture.provider] = await features(page, snapshot, fixture);
    await problems(page, fixture, `${fixture.provider}-untrusted`);
    await page.screenshot({ path: join(evidence, `${fixture.provider}-untrusted.png`) });
  }

  // Two Lua files, the second taller than the window: the status bar shows on both.
  for (const path of ["main.lua", "long.lua", "main.lua"]) {
    await open(page, path);
    await assertStatusBarShown(page, path);
  }

  await page.waitForTimeout(3000);
  assert.deepEqual(marked(), [], "Project code ran before Trust");
  const untrustedRss = rss();
  console.log("RSS before Trust", JSON.stringify(untrustedRss));
  writeFileSync(join(evidence, "untrusted.json"), JSON.stringify(before, null, 2) + "\n");

  for (const [path, documentLanguageId] of [
    ["src/main.rs", "rust"],
    ["main.lua", "lua"],
  ] as const) {
    const discovery = await call(
      page,
      "languages.discover",
      { checkout, path: join(project, path), documentLanguageId, settings: proofSettings },
      P.LanguageDiscovery
    );

    console.log("Trust request", path, JSON.stringify(discovery.trustRequest));
    assert.notDeepEqual(discovery.trustRequest?.wouldRun.workspaceTools ?? [], [], path);
  }

  const trustCard = page.getByTestId("trust-card");
  await trustCard.waitFor({ timeout: 30000 });
  const asked = await trustCard.innerText();
  console.log("Trust card:", asked);
  assert.match(asked, /Cargo|\.luarc/, "The Trust card names what Trust would run");
  await page.screenshot({ path: join(evidence, "trust-card.png") });
  await trustCard.getByRole("button", { name: "Trust rust-lua-proof", exact: true }).click();

  const after: Record<string, Awaited<ReturnType<typeof features>>> = {};

  for (const fixture of fixtures) {
    await open(page, fixture.path);
    const context = contexts.get(fixture.provider);
    assert(context !== undefined, `Missing ${fixture.provider} context`);
    const snapshot = await ready(page, checkout, fixture, context);
    after[fixture.provider] = await features(page, snapshot, fixture);
    await formatOnSave(page, fixture);
    await page.screenshot({ path: join(evidence, `${fixture.provider}-trusted.png`) });
  }

  const deadline = Date.now() + 120000;

  while (Date.now() < deadline && !(marked().includes("MARK_PLUGIN") && marked().length > 1))
    await page.waitForTimeout(500);

  console.log("Ran after Trust", marked());
  assert(marked().includes("MARK_PLUGIN"), "The .luarc plugin did not load after Trust");
  assert(
    marked().some((name) => name !== "MARK_PLUGIN"),
    "Cargo did not run after Trust"
  );
  const trustedRss = rss();
  console.log("RSS after Trust", JSON.stringify(trustedRss));

  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Editor", exact: true }).first().click();

  for (const name of ["Rust", "Lua"])
    await page.getByRole("switch", { name: `${name} language tools`, exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "settings.png") });

  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify(
      {
        passed: true,
        trustCard: asked,
        ranAfterTrust: marked(),
        rss: { untrusted: untrustedRss, trusted: trustedRss },
        trusted: after,
      },
      null,
      2
    ) + "\n"
  );
  console.log("PASS");
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

  if (process.env.POLARIS_SMOKE_KEEP !== "1")
    try {
      host.cleanup();
    } catch (cause) {
      console.error("Cleanup failed", cause);
    }

  if (process.env.POLARIS_SMOKE_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  else console.log("Retained isolated fixture", home);
}
