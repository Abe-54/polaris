/**
 * A fresh app whose only Host is the fake remote one (this Mac switched off),
 * its Daemon already installed and on the bench Harness: ⌘O, browse to a
 * folder on the remote Host, open it, New session, and a Turn runs there.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { hostPlatform } from "../../src/main/machines/fakeHost.testing.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary, sizeWindow } from "./electron.ts";
import { FAKE_ALIAS, prepareFakeHost } from "./machineFlow.ts";
import { approveAll, FIRST_TURN, initRepo } from "./sessionFlow.ts";

export interface RemoteFlowInput {
  readonly step: (message: string) => void;
  readonly show: boolean;
  /** Screenshots of each step go here, when given. */
  readonly shots: string | null;
}

/** Runs the stand-in's install on the fake Host, which starts its Daemon on the bench Harness. */
const preinstall = (dist: string, home: string) => {
  const installed = spawnSync(join(dist, hostPlatform(), "polaris"), ["install"], {
    env: { PATH: process.env.PATH, HOME: home, POLARIS_BENCH_HARNESS: "1" },
  });

  if (installed.status !== 0)
    throw new Error(`fake install failed: ${installed.stderr.toString()}`);
};

/** ⌘O, then the folder browsed on the remote Host: "~/pro", ↵ into project, ↵ opens it. */
const openRemoteFolder = async (
  page: Page,
  step: (m: string) => void,
  shoot: (name: string) => Promise<void>
) => {
  await page.keyboard.press("Meta+O");
  const field = page.getByTestId("folder-path");

  await field.waitFor({ timeout: 5000 });
  await page.locator(`[data-host="${FAKE_ALIAS}"]`).first().waitFor();
  // Every folder shows, dot-folders after the others: the install's ~/.polaris is listed.
  await page.getByTestId("folder-row").filter({ hasText: ".polaris" }).waitFor({ timeout: 10_000 });
  const names = await page.getByTestId("folder-row").allInnerTexts();

  if (names.indexOf(".polaris") < names.findIndex((n) => n.startsWith("project")))
    throw new Error(`dot-folders should follow the others: ${names.join(", ")}`);
  step(`⌘O lists every folder in ~: ${names.map((n) => n.split("\n")[0]).join(", ")}`);
  await field.fill("~/pro");
  await page.getByTestId("folder-row").filter({ hasText: "project" }).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.getByTestId("folder-open").filter({ hasText: "Open ~/project" }).waitFor();

  if ((await field.inputValue()) !== "~/project/") throw new Error("↵ didn't step into the folder");
  await shoot("open-folder");
  step("⌘O: browsed ~/project on the remote Host");
  await page.keyboard.press("Enter");
  await page.getByTestId("folder-path").waitFor({ state: "detached", timeout: 10_000 });
  await page.locator('[data-slot="chip"][aria-pressed="true"]', { hasText: "project" }).waitFor();
  step("the folder is a workspace on the remote Host, selected");
};

export const remoteFlow = async ({ step, show, shots }: RemoteFlowInput) => {
  const root = mkdtempSync(join(tmpdir(), "polaris-smoke-remote-"));
  const userData = join(root, "user-data");
  const fake = prepareFakeHost(join(root, "remote"));

  const shoot = async (page: Page, name: string) => {
    if (shots !== null) await page.screenshot({ path: join(shots, `remote-${name}.png`) });
  };

  mkdirSync(userData, { recursive: true });
  initRepo(join(fake.home, "project"));
  preinstall(fake.env.POLARIS_DESKTOP_DAEMON_DIST ?? "", fake.home);
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify({
      welcomeSeen: true,
      local: { enabled: false },
      hosts: [{ alias: FAKE_ALIAS, label: "Fake Studio" }],
    })
  );

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      ...fake.env,
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: show ? "0" : "1",
    },
  });

  try {
    const page = await app.firstWindow();

    await sizeWindow(app, 1280, 800);
    await page
      .locator(`[data-host="${FAKE_ALIAS}"][data-connection="connected"]`)
      .first()
      .waitFor({ timeout: 60_000 });
    step("fresh app, only the remote Host, connected");
    await page.getByTestId("host-stage").waitFor({ timeout: 10_000 });
    await shoot(page, "stage");
    await openRemoteFolder(page, step, (name) => shoot(page, name));
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByTestId("where-host").filter({ hasText: "Fake Studio" }).waitFor();
    await shoot(page, "new-session");
    await page.getByTestId("composer-input").fill(FIRST_TURN);
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("session-panel").waitFor({ timeout: 15_000 });
    await page.getByTestId("live-item").first().waitFor({ timeout: 20_000 });
    step("a Turn is streaming on the remote Host");
    await approveAll(page, step);
    await page.getByTestId("diff-file").first().waitFor({ timeout: 10_000 });
    await shoot(page, "turn-done");
    step("the Turn completed on the remote Host");
  } finally {
    await app.close();
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
};
