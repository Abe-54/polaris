/** Real isolated-profile acceptance: node apps/desktop/scripts/trustLanguageSmoke.ts (build first). */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { type Page } from "playwright-core";
import * as P from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-trust-desktop-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-2");

const path = join(REPO_ROOT, "slice2-acceptance.ts");

const source = "export const value: string = 123;\n";

const draft = `${source}export const unsaved = 42;\n`;

const uri = pathToFileURL(path).href;

assert.equal(existsSync(path), false, "Never overwrite an existing file");

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

writeFileSync(path, source);

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

async function launch() {
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
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });

  return page;
}

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
  let page = await launch();
  console.log("Electron connected to isolated Daemon");
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "slice2-trust" } })`
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

  const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: REPO_ROOT });
  const inspectInput = { checkout, path };
  console.log("Registered Workspace snapshot received");
  let status = await call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus);
  assert.equal(status.trust.decision, "undecided");
  assert.equal(status.ask, true);
  assert.equal(status.wouldRun.typescriptVersion, "7.0.2");
  assert.equal(status.wouldRun.native, true);
  assert.equal(
    (await call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus)).ask,
    false
  );
  status = await call(
    page,
    "languages.trust.change",
    { ...inspectInput, action: "decline", expectedRevision: status.trust.revision },
    P.LanguageTrustStatus
  );
  assert.equal(status.trust.decision, "declined");
  await app?.evaluate(({ app: electronApp }) => electronApp.exit());
  app = undefined;
  await daemon.stop();
  daemon = await startDaemon({ home: profile, benchHarness: true });
  page = await launch();
  status = await call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus);
  assert.equal(status.trust.decision, "declined");
  assert.equal(status.ask, false);
  assert.equal(status.provider, "bundled");

  const identity = await call(
    page,
    "languages.identity.get",
    {},
    Schema.Struct({ hostId: P.HostId, clientId: P.LanguageKey, connectionEpoch: P.LanguageCounter })
  );

  const settings = P.LanguageEffectiveSettings.make({
    revision: 0,
    formatOnSave: true,
    formatter: P.LanguageFormatterSelection.cases.None.make({}),
    providers: [],
    settings: {},
    origins: {},
  });

  const acquisition = {
    clientId: identity.clientId,
    contextId: "trust-acceptance",
    checkout,
    path,
    providerId: "typescript-language-server",
    settings,
    interestId: "acceptance",
  };

  let snapshot = await call(
    page,
    "languages.context.acquire",
    acquisition,
    P.LanguageContextSnapshot
  );

  await call(
    page,
    "languages.document.sync",
    {
      context: snapshot.context,
      sequence: 1,
      notification: P.LanguageDocumentNotification.cases.Open.make({
        uri,
        languageId: "typescript",
        version: 1,
        text: draft,
      }),
    },
    P.LanguageSyncAck
  );

  async function ready() {
    for (let attempt = 0; attempt < 3600; attempt++) {
      snapshot = await call(
        page,
        "languages.context.acquire",
        acquisition,
        P.LanguageContextSnapshot
      );

      if (Predicate.isTagged(snapshot.runtime, "Ready")) return;

      if (Predicate.isTagged(snapshot.runtime, "Failed")) throw new Error(snapshot.runtime.message);
      await sleep(50);
    }

    throw new Error("Provider readiness deadline");
  }

  await ready();
  console.log("Bundled server ready after persistent decline");
  status = await call(
    page,
    "languages.trust.change",
    { ...inspectInput, action: "trust", expectedRevision: status.trust.revision },
    P.LanguageTrustStatus
  );
  assert.equal(status.provider, "project");
  console.log("Trust selects project TypeScript; waiting for native server");
  await ready();
  assert.equal(snapshot.ack.acceptedSequence, 1);
  assert.deepEqual(snapshot.ack.documents, [{ uri, version: 1 }]);

  const request = (method: string, params: typeof Schema.JsonObject.Type) =>
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
        params,
        deadline: Date.now() + 15000,
      },
      P.LanguageFeatureResult
    );

  const hover = await request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 1, character: 15 },
  });

  assert.match(JSON.stringify(hover.result), /42/);
  const diagnostics = await request("textDocument/diagnostic", { textDocument: { uri } });
  assert.match(JSON.stringify(diagnostics.result), /2322/);

  const compiler = spawnSync("bunx", ["tsc", "--noEmit", "--pretty", "false", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  writeFileSync(join(evidence, "compiler.txt"), compiler.stdout + compiler.stderr);
  assert.notEqual(compiler.status, 0);
  assert.match(compiler.stdout, /TS2322/);
  assert.match(compiler.stdout, /Type 'number' is not assignable to type 'string'/);
  writeFileSync(join(evidence, "compiler.txt"), compiler.stdout);

  const restarted = await call(
    page,
    "languages.server.restart",
    { checkout, providerId: "typescript-language-server" },
    Schema.Array(P.LanguageContextSnapshot)
  );

  assert.equal(restarted.length, 1);
  assert.deepEqual(restarted[0]?.ack.documents, [{ uri, version: 1 }]);
  await ready();
  await call(
    page,
    "languages.workspace.restart",
    { workspaceId },
    Schema.Array(P.LanguageContextSnapshot)
  );
  await ready();
  status = await call(
    page,
    "languages.trust.change",
    { ...inspectInput, action: "use-bundled", expectedRevision: status.trust.revision },
    P.LanguageTrustStatus
  );
  assert.equal(status.provider, "bundled");
  await ready();
  await page.screenshot({ path: join(evidence, "trust-preload.png") });
  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify(
      {
        passed: true,
        repository: REPO_ROOT,
        projectTypeScript: "7.0.2",
        askOnce: true,
        declineAcrossAppAndDaemonRestart: true,
        unsavedTextRetained: true,
        nativeDiagnostics: diagnostics.result,
        compiler: compiler.stdout,
        restartRpcs: true,
        bundledOverride: true,
      },
      null,
      2
    )
  );
  console.log(
    "PASS: Trust facts, persistent decline, native TS 7 diagnostics, unsaved text, restart RPCs and bundled override through Electron main/preload"
  );
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(path, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
