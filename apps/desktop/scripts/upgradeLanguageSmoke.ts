/** Copied legacy home, a reversible install verification failure, then Check again in real Electron. */
import { Schema } from "effect";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const home = await mkdtemp(join(await realpath("/tmp"), "polaris-upgrade-ui-"));

const evidence = join(REPO_ROOT, ".dagr/evidence/upgrade-repro");

await cp(join(evidence, "dev-home"), home, { recursive: true });

for (const name of ["daemon.lock", "daemon.pid"]) await rm(join(home, name), { force: true });

const project = join(home, "project");

const userData = join(home, "user-data");

await mkdir(project);

await mkdir(userData);

await writeFile(join(project, "upgrade-acceptance.ts"), "export const value = 42;\n");

await writeFile(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const nodeRoot = join(home, "languages", createHash("sha256").update("node").digest("hex"));

const pointer = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ identity: Schema.String }))
)(await readFile(join(nodeRoot, "active.json"), "utf8"));

const executable = join(nodeRoot, "versions", pointer.identity.slice(7), "payload/bin/node");

const mode = (await stat(executable)).mode & 0o777;

await chmod(executable, 0o600);

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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  console.log(
    await page.evaluate(
      `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "Upgrade acceptance" } })`
    )
  );
  await page
    .getByRole("button", { name: /Upgrade acceptance/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText("upgrade-acceptance.ts", { exact: true }) })
    .click({ timeout: 15_000 });
  const pill = page.getByTestId("language-pill");
  await page
    .locator('[data-testid="language-pill"][data-kind="unavailable"]')
    .waitFor({ timeout: 60_000 });
  await pill.click();
  const popover = page.getByTestId("language-popover");
  await popover.waitFor();
  assert.match(
    (await popover.textContent()) ?? "",
    /Stored file mode differs from receipt \(install-failed\)/
  );

  for (const theme of ["dark", "light"])
    for (const density of ["calm", "balanced", "compact"]) {
      await page.evaluate(
        `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}", motion: "reduce", diffPalette: "cvd" } })`
      );
      await page
        .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
        .waitFor({ state: "attached" });

      if ((await popover.count()) === 0) await pill.click();
      await popover.screenshot({ path: join(evidence, `typed-failure-${theme}-${density}.png`) });
    }

  await page.getByRole("menuitem", { name: "Check again" }).click();
  await page
    .getByText("Stored file mode differs from receipt (install-failed).", { exact: true })
    .waitFor();
  await chmod(executable, mode);
  await page.getByRole("menuitem", { name: "Check again" }).focus();
  await page.keyboard.press("Enter");
  await page
    .locator(
      '[data-testid="language-pill"][data-kind="ready"], [data-testid="language-pill"][data-kind="bundled"]'
    )
    .waitFor({ timeout: 180_000 });
  await pill.screenshot({ path: join(evidence, "check-again-ready.png") });
  console.log(
    "Typed failure visible in six appearances; repeat failure preserved; keyboard Check again reached Ready."
  );
} finally {
  await app?.close();
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });
}
