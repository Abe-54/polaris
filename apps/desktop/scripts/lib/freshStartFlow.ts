/**
 * A fresh launch where the user is quick: the local Host has just connected
 * and New session opens at once, before any availability probe has finished,
 * with no onboarding and no `refresh: true` to rescue it (V2 bug 1: the chip
 * stayed "Checking harnesses…" for the Daemon's life).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary, sizeWindow } from "./electron.ts";
import { initRepo } from "./sessionFlow.ts";

export const freshStartFlow = async (options: {
  readonly step: (message: string) => void;
  readonly show: boolean;
}) => {
  const home = mkdtempSync(join(tmpdir(), "polaris-smoke-fresh-"));
  const userData = join(home, "user-data");
  const repo = join(home, "repo");
  mkdirSync(userData, { recursive: true });
  initRepo(repo);
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));
  const daemon = await startDaemon({ home, benchHarness: true });

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: options.show ? "0" : "1",
    },
  });

  try {
    const page = await app.firstWindow();
    await sizeWindow(app, 1280, 800);
    await page
      .locator('[data-host="local"][data-connection="connected"]')
      .waitFor({ timeout: 15_000 });

    const connectedAt = Date.now();

    await page.evaluate(
      `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "fresh-repo" } })`
    );

    await page
      .getByRole("button", { name: /fresh-repo/ })
      .first()
      .click();
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByTestId("new-session").waitFor();
    options.step(`fresh launch: New session open ${Date.now() - connectedAt} ms after connect`);

    // A ready Harness gets pre-selected; before the fix this never happened.
    const picked = page.locator('[role="radiogroup"][aria-label="Harness"] [aria-checked="true"]');
    await picked.waitFor({ timeout: 10_000 });
    const pickedId = await picked.getAttribute("data-testid");

    if (pickedId !== "harness-claude" && pickedId !== "harness-codex")
      throw new Error(`fresh launch pre-selected ${pickedId}, which isn't ready`);

    await page.getByTestId("composer-input").fill("A first Turn, right after launch");

    if (await page.getByRole("button", { name: "Send" }).isDisabled())
      throw new Error("fresh launch: Send stayed disabled");

    options.step(`fresh launch: ${pickedId} ready ${Date.now() - connectedAt} ms after connect`);
  } finally {
    await app.close();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
};
