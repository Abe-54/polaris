/** Real main/preload/renderer with a local fake feed and a stand-in Squirrel downloader. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication } from "playwright-core";
import { Schema } from "effect";
import { scriptedElectron as electron, electronBinary, OUT_DIR } from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";
import { MOCK_KEYCHAIN } from "./lib/githubFlow.ts";
import { takeScriptLease } from "../../../tooling/leases.ts";
import type { PolarisApi } from "../src/shared/api.ts";

declare const window: { readonly polaris: PolarisApi };

await takeScriptLease("smoke");

const root = mkdtempSync(join(tmpdir(), "polaris-app-update-smoke-"));

const entry = join(OUT_DIR, "main", "app-update-smoke.mjs");

const Receipt = Schema.Struct({ installs: Schema.Number, downloaded: Schema.Boolean });

const requests: Array<{
  path: string;
  id: string | string[] | undefined;
  os: string | string[] | undefined;
}> = [];

let offer = false;

const server = createServer((request, response) => {
  const path = request.url ?? "";
  requests.push({
    path,
    id: request.headers["x-polaris-install-id"],
    os: request.headers["x-polaris-macos-version"],
  });

  if (path.endsWith(".zip")) {
    response.end(Buffer.from([80, 75, 3, 4]));

    return;
  }

  if (!offer) {
    response.writeHead(204);
    response.end();

    return;
  }

  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      url: `${origin}/Polaris-0.5.0-arm64-mac.zip`,
      name: "October release",
      notes: "fake",
      pub_date: "2026-10-02T00:00:00Z",
    })
  );
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address());

const origin = `http://127.0.0.1:${address.port}`;

// This fixture replaces native networking only; the bundled production main and IPC run unchanged.
writeFileSync(
  entry,
  `
import { app, autoUpdater } from 'electron';
import { writeFileSync } from 'node:fs';
Object.defineProperty(app, 'isPackaged', { get: () => true });
let feed; let downloaded = false; let installs = 0;
autoUpdater.setFeedURL = (value) => { feed = value; };
autoUpdater.checkForUpdates = () => {
  autoUpdater.emit('checking-for-update');
  void (async () => {
    const url = new URL(feed.url);
    if (url.origin !== 'https://polaris.lux.dev') throw new Error('unexpected feed origin');
    const response = await fetch(${JSON.stringify(origin)} + url.pathname, { headers: feed.headers });
    if (response.status === 204) { autoUpdater.emit('update-not-available'); return; }
    const release = await response.json();
    if (!release.url.startsWith(${JSON.stringify(origin)} + '/')) throw new Error('unexpected ZIP origin');
    autoUpdater.emit('update-available');
    const zip = await fetch(release.url);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    if (bytes[0] !== 80 || bytes[1] !== 75) throw new Error('invalid fake ZIP');
    downloaded = true;
    autoUpdater.emit('update-downloaded', {}, release.notes, release.name, new Date(release.pub_date), release.url);
  })().catch(() => autoUpdater.emit('error', new Error('fake feed failed')));
};
autoUpdater.quitAndInstall = () => { if (!downloaded) throw new Error('not downloaded'); installs++; app.quit(); };
app.on('quit', () => writeFileSync(process.env.POLARIS_UPDATE_RECEIPT, JSON.stringify({ installs, downloaded })));
await import('./index.js');
`
);

writeFileSync(
  join(root, "package.json"),
  JSON.stringify({ name: "polaris-update-fixture", version: "0.4.0", type: "module", main: entry })
);

const daemon = await startDaemon({ home: join(root, "daemon"), benchHarness: true });

let app: ElectronApplication | null = null;

const run = async (restart: boolean) => {
  const userData = join(root, "app-data");

  if (restart) {
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));
  }

  const receiptPath = join(root, restart ? "restart.json" : "quit.json");
  offer = false;
  const before = requests.length;
  app = await electron.launch({
    executablePath: electronBinary(),
    args: [root, MOCK_KEYCHAIN],
    env: {
      ...process.env,
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_HIDDEN: "1",
      POLARIS_UPDATE_RECEIPT: receiptPath,
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => console.log(chunk.toString().trim()));
  app.process().stderr?.on("data", (chunk: Buffer) => console.log(chunk.toString().trim()));
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  console.log("App update smoke: window opened");

  if (!restart) {
    await page.waitForFunction(async () => {
      const result = await window.polaris.request("updates.get", {});

      return result.ok && !result.value.automatic && result.value.phase === "idle";
    });
    assert.equal(requests.length, before);
    assert.equal(readFileSync(join(userData, "install-id"), "utf8").trim(), requests[0]?.id);
    await page.evaluate(() => window.polaris.request("updates.check", {}));
  }

  await page.waitForFunction(async () => {
    const result = await window.polaris.request("updates.get", {});

    return result.ok && result.value.phase === "current";
  });
  assert.equal(requests[before]?.path, "/api/update/darwin-arm64/0.4.0");
  console.log("App update smoke: launch check current");

  if (restart)
    assert.match(
      String(requests[before]?.id),
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
    );
  else assert.equal(requests[before]?.id, undefined);
  assert.match(String(requests[before]?.os), /^\d+\.\d+/);
  assert.equal(requests[0]?.id, readFileSync(join(userData, "install-id"), "utf8").trim());
  await page.evaluate(() => window.polaris.request("updates.setAutomatic", { enabled: false }));
  await page.evaluate(() => window.polaris.request("updates.check", {}));
  await page.waitForFunction(async () => {
    const r = await window.polaris.request("updates.get", {});

    return r.ok && r.value.phase === "current";
  });
  assert.equal(requests[before + 1]?.id, undefined);
  offer = true;
  await page.evaluate(() => window.polaris.request("updates.check", {}));
  await page.waitForFunction(async () => {
    const r = await window.polaris.request("updates.get", {});

    return r.ok && r.value.phase === "ready" && r.value.availableVersion === "0.5.0";
  });

  const labels = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items[0]?.submenu?.items.map((item) => item.label)
  );

  console.log("App update smoke: downloaded and ready");

  assert(labels?.includes("Restart to update to 0.5.0"));
  assert(labels?.includes("Quit and update"));
  await page.keyboard.press("Meta+Shift+p");
  await page.getByRole("dialog", { name: "Command Palette" }).waitFor();
  await page
    .getByRole("dialog", { name: "Command Palette" })
    .getByText("Restart to update", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  console.log("App update smoke: unsaved quit cancelled");
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    false
  );
  await page.evaluate(() =>
    window.polaris.request("editor.publishDirty", {
      files: [{ hostKey: "local", path: "/tmp/unsaved.txt", unkept: false }],
    })
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
  });
  await page.evaluate(() => window.polaris.request("updates.restart", {}));
  // Flush main's cancelled prompt before another quit request.
  await app.evaluate(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const closed = new Promise<void>((resolve) => app?.once("close", () => resolve()));

  if (restart) await page.evaluate(() => window.polaris.request("updates.restart", {}));
  else await app.evaluate(({ app: nativeApp }) => nativeApp.quit());
  await closed;
  app = null;

  const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Receipt))(
    readFileSync(receiptPath, "utf8")
  );

  assert.equal(receipt.downloaded, true);
  assert.equal(receipt.installs, restart ? 1 : 0);
  console.log(
    `App update smoke: ${restart ? "restart" : "quit without relaunch"}, cancel unsaved quit, hide window, ID opt-out: ok`
  );
};

try {
  await run(true);
  await run(false);
} finally {
  // SAFETY: run mutates app across awaits; TypeScript only sees its initial null.
  const active = app as ElectronApplication | null;

  if (active !== null) {
    await active
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
    await active.close();
  }

  await daemon.stop();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  rmSync(entry, { force: true });
  rmSync(root, { recursive: true, force: true });
}
