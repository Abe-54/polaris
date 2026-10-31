/** Focused Electron smoke: first-install approval, update IPC, progress and settings on a fake Host. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { machineFlow, prepareFakeHost } from "./lib/machineFlow.ts";
import { MOCK_KEYCHAIN } from "./lib/githubFlow.ts";

const root = mkdtempSync(join(tmpdir(), "polaris-update-smoke-"));

const userData = join(root, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const host = prepareFakeHost(join(root, "remote"));

const daemon = await startDaemon({ home: join(root, "local"), benchHarness: true });

let app: ElectronApplication | null = null;

try {
  app = await electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR, MOCK_KEYCHAIN],
    timeout: 30_000,
    env: {
      ...process.env,
      ...host.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });
  console.log("Daemon update smoke: app launched");
  const page = await app.firstWindow();
  await page.waitForFunction("window.polaris !== undefined");
  await machineFlow({ page, host, step: console.log, openHosts: null, shoot: async () => {} });
  await app.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents())
      contents.send("polaris:app", { kind: "command", id: "settings.hosts" });
  });
  await page.getByTestId("hosts-settings").waitFor();
  await page.getByText("Upgraded to 0.0.0-dev.900.abc1234", { exact: false }).waitFor();

  if (await page.locator("[data-sonner-toast]").filter({ hasText: "Daemon upgraded" }).count())
    throw new Error("Daemon Upgrade still makes a success toast");
  console.log("Daemon Upgrade smoke: quiet Hosts row, no success toast");
  console.log("Daemon update IPC smoke: ok");
} finally {
  await app?.close();
  host.stop();
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
}
