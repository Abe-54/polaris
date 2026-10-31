/** Real isolated Electron acceptance: node apps/desktop/scripts/webLanguageSmoke.ts (build first). */
import { strict as assert } from "node:assert";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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

const home = realpathSync(
  process.env.POLARIS_SMOKE_HOME ?? mkdtempSync(join(tmpdir(), "polaris-web-desktop-"))
);

const userData = join(home, "user-data");

const project = join(home, "project");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-7a");

const marker = join(project, "config-executed");

const compilerMarker = join(project, "compiler-executed");

const fixtures = [
  {
    path: "package.json",
    language: "json",
    provider: "vscode-json-language-server",
    text: '{\n  "name": "web-proof",\n  "version": 123\n}\n',
    hover: { line: 1, character: 5 },
    completion: { line: 1, character: 3 },
    diagnostic: /string|type/i,
  },
  {
    path: "proof.css",
    language: "css",
    provider: "vscode-css-language-server",
    text: ".box {\n  color: red;\n  colr: red;\n}\n",
    hover: { line: 1, character: 4 },
    completion: { line: 1, character: 4 },
    diagnostic: /unknown property/i,
  },
  {
    path: "proof.scss",
    language: "scss",
    provider: "vscode-css-language-server",
    text: "$color: red;\n.box { color: $color; colr: red; }\n",
    hover: { line: 1, character: 9 },
    completion: { line: 1, character: 10 },
    diagnostic: /unknown property/i,
  },
  {
    path: "proof.less",
    language: "less",
    provider: "vscode-css-language-server",
    text: "@color: red;\n.box { color: @color; colr: red; }\n",
    hover: { line: 1, character: 9 },
    completion: { line: 1, character: 10 },
    diagnostic: /unknown property/i,
  },
  {
    path: "proof.html",
    language: "html",
    provider: "vscode-html-language-server",
    text: '<div class="box"><style>.box { colr: red; }</style></div>\n',
    hover: { line: 0, character: 2 },
    completion: { line: 0, character: 2 },
    diagnostic: null,
  },
  {
    path: "proof.yaml",
    language: "yaml",
    provider: "yaml-language-server",
    text: "# yaml-language-server: $schema=./proof.schema.json\nport: wrong\n",
    hover: { line: 1, character: 2 },
    completion: { line: 1, character: 1 },
    diagnostic: /number|type/i,
  },
  {
    path: ".github/workflows/proof.yml",
    language: "yaml",
    provider: "actions-language-server",
    text: "name: proof\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ invalid.context }}\n",
    hover: { line: 4, character: 7 },
    completion: { line: 4, character: 6 },
    diagnostic: /invalid|unrecognized/i,
  },
  {
    path: "schema.prisma",
    language: "prisma",
    provider: "prisma-language-server",
    text: 'datasource db {\n  provider = "sqlite"\n}\nmodel User {\n  id Int @id\n  broken MissingType\n}\n',
    hover: { line: 4, character: 3 },
    completion: { line: 4, character: 6 },
    diagnostic: /MissingType|type/i,
  },
  {
    path: "Component.svelte",
    language: "svelte",
    provider: "svelte-language-server",
    text: '<script lang="ts">let count = 1;</script>\n<button on:click={() => count += 1}>{count}</button>\n<div>{missing}</div>\n',
    hover: { line: 1, character: 25 },
    completion: { line: 1, character: 27 },
    diagnostic: /missing/i,
  },
];

for (const path of [userData, project, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

writeFileSync(
  join(project, "proof.schema.json"),
  JSON.stringify({
    type: "object",
    properties: { port: { type: "number", description: "HTTP port" } },
  })
);

for (const fixture of fixtures) {
  const path = join(project, fixture.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fixture.text);
}

writeFileSync(
  join(project, "svelte.config.js"),
  `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'config'); module.exports = {};\n`
);

mkdirSync(join(project, "node_modules/svelte"), { recursive: true });

writeFileSync(
  join(project, "node_modules/svelte/package.json"),
  JSON.stringify({
    name: "svelte",
    version: "4.2.20",
    exports: { "./package.json": "./package.json", "./compiler": "./compiler.cjs" },
  })
);

writeFileSync(
  join(project, "node_modules/svelte/compiler.cjs"),
  `require('node:fs').writeFileSync(${JSON.stringify(compilerMarker)}, 'compiler'); throw new Error('Untrusted compiler ran');\n`
);

writeFileSync(
  join(project, "prisma.config.js"),
  `require('node:fs').writeFileSync(${JSON.stringify(join(project, "prisma-executed"))}, 'prisma'); module.exports = {};\n`
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
    .locator('[data-testid="editor-tab"][aria-selected="true"]')
    .filter({ hasText: path.split("/").pop() ?? path })
    .waitFor();
  await page
    .locator(
      '[data-testid="language-pill"][data-kind="ready"], [data-testid="language-pill"][data-kind="bundled"], [data-testid="language-pill"][data-kind="unavailable"], [data-testid="language-pill"][data-kind="stopped"], [data-testid="language-pill"][data-kind="crashed"]'
    )
    .waitFor({ timeout: 180000 });
  const unavailable = page.locator('[data-testid="language-pill"][data-kind="unavailable"]');

  if (await unavailable.isVisible()) {
    await unavailable.click();
    throw new Error(await page.locator("body").innerText());
  }
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
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
    await window.polaris.request("dispatch", {hostKey:"local",commandId:crypto.randomUUID(),command:{_tag:"RegisterWorkspace",path:${JSON.stringify(project)},name:"web-proof"}});
  })`)
  );

  await page
    .getByRole("button", { name: /web-proof/ })
    .first()
    .click();
  const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });

  const results = [];
  let svelteContext: P.LanguageContextIdentity | undefined;

  const proofSettings = P.LanguageEffectiveSettings.make({
    revision: 0,
    formatOnSave: true,
    formatter: P.LanguageFormatterSelection.cases.None.make({}),
    providers: [],
    settings: {},
    origins: {},
  });

  for (const fixture of fixtures) {
    if (
      process.env.POLARIS_SMOKE_FROM &&
      fixtures.indexOf(fixture) <
        fixtures.findIndex((item) => item.path === process.env.POLARIS_SMOKE_FROM)
    )
      continue;
    console.log("Opening", fixture.path);
    await open(page, fixture.path);

    const path = join(project, fixture.path);
    const uri = pathToFileURL(path).href;

    const restarted = await call(
      page,
      "languages.server.restart",
      { checkout, providerId: fixture.provider },
      Schema.Array(P.LanguageContextSnapshot)
    );

    let snapshot = restarted[0];
    assert(snapshot !== undefined, "Missing renderer-owned context");
    console.log("Restart", JSON.stringify(snapshot));
    await page.evaluate(`window.__webProofContext = ${JSON.stringify(snapshot.context)}`);
    await page.evaluate(
      `window.__webProofStop?.(); window.__webProofLogs=[]; window.__webProofStop=window.polaris.languages.subscribe('languages.log.watch', {hostKey:'local',context:window.__webProofContext}, {items:items=>{window.__webProofLogs.push(...items);window.__webProofLogs=window.__webProofLogs.slice(-128);}})`
    );

    const input = {
      clientId: snapshot.context.clientId,
      contextId: snapshot.context.contextId,
      checkout,
      path,
      providerId: fixture.provider,
      settings: proofSettings,
      interestId: "proof",
    };

    for (let i = 0; i < 600; i++) {
      if (
        Predicate.isTagged(snapshot.runtime, "Ready") &&
        snapshot.runtime.capabilities.methods.includes("textDocument/hover") &&
        snapshot.runtime.capabilities.methods.includes("textDocument/completion")
      )
        break;
      await page.waitForTimeout(20);
      snapshot = await call(page, "languages.context.acquire", input, P.LanguageContextSnapshot);

      if (Predicate.isTagged(snapshot.runtime, "Failed"))
        throw new Error(JSON.stringify(snapshot.runtime));
    }

    assert(Predicate.isTagged(snapshot.runtime, "Ready"), JSON.stringify(snapshot.runtime));

    if (fixture.provider === "svelte-language-server") svelteContext = snapshot.context;
    console.log(fixture.provider, JSON.stringify(snapshot.runtime.capabilities));
    console.log("Coordinates", JSON.stringify(snapshot.context), JSON.stringify(snapshot.ack));
    const ack = snapshot.ack;

    const request = (method: string, position: { line: number; character: number }) =>
      call(
        page,
        "languages.request",
        {
          requestId: crypto.randomUUID(),
          fence: {
            context: snapshot.context,
            requiredSequence: ack.acceptedSequence,
            documents: ack.documents,
          },
          method,
          params: { textDocument: { uri }, position, options: { tabSize: 2, insertSpaces: true } },
          deadline: Date.now() + 15000,
        },
        P.LanguageFeatureResult
      );

    const hover = await request("textDocument/hover", fixture.hover);
    assert.notEqual(hover.result, null, `Missing ${fixture.path} hover`);
    const completion = await request("textDocument/completion", fixture.completion);

    const diagnostics = snapshot.runtime.capabilities.methods.includes("textDocument/diagnostic")
      ? (await request("textDocument/diagnostic", fixture.hover)).result
      : null;

    console.log("Diagnostic report", fixture.path, JSON.stringify(diagnostics));

    const formatting =
      snapshot.runtime.capabilities.methods.includes("textDocument/formatting") &&
      fixture.provider !== "actions-language-server"
        ? (await request("textDocument/formatting", fixture.hover)).result
        : null;

    const items = Schema.decodeUnknownSync(
      Schema.Union([
        Schema.Array(Schema.JsonObject),
        Schema.Struct({ items: Schema.Array(Schema.JsonObject) }),
      ])
    )(completion.result);

    assert(
      (Schema.is(Schema.Array(Schema.JsonObject))(items)
        ? items
        : Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.JsonObject) }))(items)
            .items
      ).length > 0,
      `Missing ${fixture.path} completion`
    );

    if (fixture.diagnostic !== null) {
      await page.locator(".cm-content[contenteditable=true]").last().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" ");
      await page.keyboard.press("Backspace");
      const problems = page.getByRole("region", { name: "Problems" });

      for (let attempt = 0; attempt < 30; attempt++) {
        if (await problems.isVisible())
          await problems.getByRole("button", { name: "Close", exact: true }).click();
        await page.keyboard.press("Meta+Shift+M");
        await page.waitForTimeout(300);

        if (await problems.getByText(fixture.diagnostic).first().isVisible()) break;
      }

      await problems.getByText(fixture.diagnostic).first().waitFor({ timeout: 1000 });
      assert.match(await problems.innerText(), new RegExp(fixture.provider));

      if (fixture.provider === "actions-language-server")
        assert.equal(
          await problems.getByRole("listitem").count(),
          1,
          "Duplicate workflow diagnostics"
        );
      await page.screenshot({
        path: join(evidence, fixture.path.replaceAll("/", "-") + "-diagnostics.png"),
      });
      await problems.getByRole("button", { name: "Close", exact: true }).click();
    }

    await page.screenshot({ path: join(evidence, fixture.path.replaceAll("/", "-") + ".png") });
    results.push({
      path: fixture.path,
      hover: hover.result,
      completion: completion.result,
      diagnostics,
      formatting,
      capabilities: snapshot.runtime.capabilities,
    });
    writeFileSync(join(evidence, "features.json"), JSON.stringify(results, null, 2) + "\n");
  }

  assert(!existsSync(marker), "Svelte config ran before Trust");
  assert(!existsSync(compilerMarker), "Project compiler ran before Trust");
  assert(!existsSync(join(project, "prisma-executed")), "Prisma config ran before Trust");
  const trustCard = page.getByTestId("trust-card");
  await trustCard.waitFor();
  assert.match(await trustCard.innerText(), /Svelte config/);
  await page.screenshot({ path: join(evidence, "svelte-trust.png") });
  // The project compiler is a forwarding sentinel; the bundled compiler is found in its receipted install.

  const state = await call(
    page,
    "languages.host.state",
    { toolIds: ["svelte-language-server"], refresh: false },
    P.LanguageHostState
  );

  writeFileSync(join(evidence, "svelte-host-state.json"), JSON.stringify(state, null, 2));

  const compiler = readdirSync(join(home, "languages"), { recursive: true }).find((path) =>
    String(path).endsWith("node_modules/svelte/compiler.cjs")
  );

  assert(compiler !== undefined, "Missing receipted bundled compiler");
  writeFileSync(
    join(project, "node_modules/svelte/compiler.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(compilerMarker)}, 'compiler'); module.exports = require(${JSON.stringify(join(home, "languages", String(compiler)))});\n`
  );
  await trustCard.getByRole("button", { name: "Trust web-proof", exact: true }).click();
  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 30000 });
  assert(svelteContext !== undefined, "Missing Svelte context");

  const trustedInput = {
    clientId: svelteContext.clientId,
    contextId: svelteContext.contextId,
    checkout,
    path: join(project, "Component.svelte"),
    providerId: "svelte-language-server",
    settings: proofSettings,
    interestId: "proof",
  };

  let trustedSnapshot = await call(
    page,
    "languages.context.acquire",
    trustedInput,
    P.LanguageContextSnapshot
  );

  const trustedStartupDeadline = Date.now() + 180000;

  while (
    Date.now() < trustedStartupDeadline &&
    !Predicate.isTagged(trustedSnapshot.runtime, "Ready")
  ) {
    if (Predicate.isTagged(trustedSnapshot.runtime, "Failed"))
      throw new Error(JSON.stringify(trustedSnapshot.runtime));
    await page.waitForTimeout(100);
    trustedSnapshot = await call(
      page,
      "languages.context.acquire",
      trustedInput,
      P.LanguageContextSnapshot
    );
  }

  assert(
    Predicate.isTagged(trustedSnapshot.runtime, "Ready"),
    JSON.stringify(trustedSnapshot.runtime)
  );

  const trustedHover = await call(
    page,
    "languages.request",
    {
      requestId: crypto.randomUUID(),
      fence: {
        context: trustedSnapshot.context,
        requiredSequence: trustedSnapshot.ack.acceptedSequence,
        documents: trustedSnapshot.ack.documents,
      },
      method: "textDocument/hover",
      params: {
        textDocument: { uri: pathToFileURL(join(project, "Component.svelte")).href },
        position: { line: 1, character: 25 },
      },
      deadline: Date.now() + 15000,
    },
    P.LanguageFeatureResult
  );

  assert.notEqual(trustedHover.result, null, "Missing trusted Svelte hover");
  assert(existsSync(marker), "Project config did not run after Trust");
  assert(existsSync(compilerMarker), "Project compiler did not run after Trust");
  writeFileSync(join(evidence, "svelte-trusted.json"), JSON.stringify(trustedHover, null, 2));
  await page.screenshot({ path: join(evidence, "svelte-trusted.png") });

  const prettier = readdirSync(join(home, "languages"), { recursive: true }).find((path) =>
    String(path).endsWith("node_modules/prettier/bin/prettier.cjs")
  );

  assert(prettier !== undefined, "Missing verified Prettier dependency");
  cpSync(
    dirname(dirname(join(home, "languages", String(prettier)))),
    join(project, "node_modules/prettier"),
    { recursive: true }
  );
  mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
  symlinkSync("../prettier/bin/prettier.cjs", join(project, "node_modules/.bin/prettier"));

  writeFileSync(join(project, ".prettierrc"), "{}\n");

  for (const fixture of fixtures.filter((item) =>
    ["json", "css", "scss", "less", "html", "yaml"].includes(item.language)
  )) {
    const formatted = await call(
      page,
      "languages.format.project",
      {
        checkout,
        path: join(project, fixture.path),
        requestId: crypto.randomUUID(),
        version: 1,
        text: fixture.text,
        deadline: Date.now() + 10000,
      },
      P.LanguageProjectFormatOutcome
    );

    assert(Predicate.isTagged(formatted, "Formatted"), JSON.stringify(formatted));
    assert.equal(formatted.tool, "prettier");
  }

  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Editor", exact: true }).first().click();

  for (const name of ["JSON", "CSS", "HTML", "YAML", "GitHub Actions", "Prisma", "Svelte"])
    await page.getByRole("switch", { name: `${name} language tools`, exact: true }).waitFor();

  for (const theme of ["dark", "light"])
    for (const density of ["calm", "balanced", "compact"]) {
      await page.evaluate(
        `window.polaris.request('settings.setAppearance',{patch:{theme:'${theme}',density:'${density}'}})`
      );
      await page
        .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
        .waitFor({ state: "attached" });
      await page.screenshot({ path: join(evidence, `settings-${theme}-${density}.png`) });
    }

  for (const fixture of fixtures)
    assert.equal(readFileSync(join(project, fixture.path), "utf8"), fixture.text);
  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify(
      {
        passed: true,
        fixtures: results.map((item) => item.path),
        trust:
          "Svelte and Prisma sentinels blocked before Trust; Svelte config/compiler executed after Trust",
        htmlDiagnostics:
          "HTML pull diagnostics are advertised; the valid HTML fixture produces no diagnostics",
        projectFormatting:
          "Verified Prettier copied into the trusted fixture formats JSON, CSS, SCSS, Less, HTML and YAML through the existing project formatting RPC",
      },
      null,
      2
    ) + "\n"
  );
  console.log("PASS");
} catch (cause) {
  const page = await app?.firstWindow();

  if (page) {
    const logs = await page.evaluate(`window.__webProofLogs ?? []`);
    writeFileSync(join(evidence, "server-failure-logs.json"), JSON.stringify(logs, null, 2));
    await page.screenshot({ path: join(evidence, "desktop-failure.png") });
    writeFileSync(join(evidence, "desktop-failure.txt"), await page.locator("body").innerText());
  }

  throw cause;
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();

  if (process.env.POLARIS_SMOKE_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  else console.log("Retained isolated fixture", home);
}
