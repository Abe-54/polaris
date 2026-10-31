#!/usr/bin/env node
/**
 * Add a real remote Host through the Desktop App, as a user does: the first-run
 * card's "Browse hosts", pick the alias from ~/.ssh/config, check the approval
 * card's SHA-256 against the build, approve, and wait for Connected. Then read
 * its Harnesses, and start one short session in its home directory if a
 * Harness is ready. Screenshots of every step go to <dir>.
 *
 * It installs a real Daemon on the Host (~/.polaris, a user service), so it
 * refuses to run unless asked:
 *
 *   POLARIS_REAL_HOST=1 node scripts/realHost.ts <alias> <dir> [--session "<prompt>" [--harness claude,codex]]
 *
 * With --session it runs one Turn per Harness (default claude) from the new-session page
 * and waits for Idle. A Harness that isn't ready stops the run: it never signs in.
 *
 * Uses the real ssh and ~/.ssh/config, read only; Polaris's ssh never writes
 * known_hosts and never forwards the agent. The builds come from
 * apps/daemon/dist (`bun scripts/build-daemon.ts <platform>`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { type Page } from "playwright-core";
import type { MachineView, PolarisApi } from "../src/shared/api.ts";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  REPO_ROOT,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

declare const window: { readonly polaris: PolarisApi };

const [alias, dir] = process.argv.slice(2);

const at = process.argv.indexOf("--session");

const prompt = at === -1 ? null : (process.argv[at + 1] ?? null);

const harnessAt = process.argv.indexOf("--harness");

const sessionHarnesses = (harnessAt === -1 ? "claude" : (process.argv[harnessAt + 1] ?? "claude"))
  .split(",")
  .filter((h) => h !== "");

if (process.env.POLARIS_REAL_HOST !== "1" || alias === undefined || dir === undefined) {
  console.error(
    "Refusing: installs a real Daemon. POLARIS_REAL_HOST=1 node scripts/realHost.ts <alias> <dir>"
  );
  process.exit(2);
}

const dist = join(REPO_ROOT, "apps/daemon/dist");

const Manifest = Schema.Struct({
  platforms: Schema.Record(Schema.String, Schema.Struct({ sha256: Schema.String })),
});

const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
  readFileSync(join(dist, "manifest.json"), "utf8")
);

const step = (message: string) => console.log(`real: ${message}`);

const home = mkdtempSync(join(tmpdir(), "polaris-real-"));

const daemon = await startDaemon({ home, benchHarness: true });

mkdirSync(dir, { recursive: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_DAEMON_DIST: dist,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const shoot = async (page: Page, name: string) => {
  const path = join(dir, `${name}.png`);

  await page.screenshot({ path });
  step(`saved ${path}`);
};

/** The machine row for `alias`, once `ready` holds. */
const machine = (page: Page, ready: string, timeout: number) =>
  page.evaluate(
    (args) =>
      new Promise<MachineView>((resolve, reject) => {
        let last: MachineView | undefined;

        const stop = window.polaris.subscribe(
          "machines",
          {},
          {
            items: (lists) => {
              last = lists.at(-1)?.find((m) => m.key === args.alias);

              if (last === undefined) return;

              const done =
                args.ready === "offer"
                  ? last.install?.step === "approval" || last.status?.state === "connected"
                  : last.status?.state === "connected" && last.install?.step !== "installing";

              if (!done) return;
              clearTimeout(timer);
              stop();
              resolve(last);
            },
          }
        );

        const timer = setTimeout(() => {
          stop();
          reject(new Error(`timed out; last ${JSON.stringify(last)}`));
        }, args.timeout);
      }),
    { alias, ready, timeout }
  );

const row = (page: Page) => page.getByTestId(`machine-${alias}`);

const addHost = async (page: Page) => {
  await page.getByRole("button", { name: "Browse hosts" }).click();
  await page.getByTestId("add-machine").waitFor({ timeout: 10_000 });
  await page.getByRole("radio", { name: new RegExp(`^${alias}\\b`) }).click();
  await shoot(page, "01-add-host");
  await page.getByTestId("add-machine").getByRole("button", { name: "Add host" }).click();
  step(`added ${alias}; probing over ssh`);
};

/** Approves the first install after checking the card shows this build's SHA-256. */
const approve = async (page: Page, found: MachineView) => {
  const offer = found.install?.offer ?? null;

  if (offer === null) return;
  const expected = manifest.platforms[offer.platform]?.sha256;

  if (offer.sha256 !== expected) throw new Error(`offered ${offer.sha256}, built ${expected}`);
  const card = await page.getByTestId("install-approval").innerText();

  if (!card.replaceAll(/\s/g, "").includes(offer.sha256))
    throw new Error("the card lacks the SHA-256");
  step(
    `approval card: ${offer.platform}, polaris ${offer.version}, SHA-256 ${offer.sha256} matches the build`
  );
  await shoot(page, "02-approve-install");
  const started = Date.now();

  await page.getByRole("button", { name: "Approve and install" }).click();
  await shoot(page, "03-installing");
  const done = await machine(page, "connected", 20 * 60_000);

  step(`installed and connected in ${Math.round((Date.now() - started) / 1000)} s`);
  step(`outcome: ${JSON.stringify(done.install?.outcome)}`);
};

const harnesses = async (page: Page) => {
  const list = row(page).getByRole("region", { name: "Harnesses", exact: true });

  await list
    .getByText(/Ready|Needs sign-in|Not installed|Needs a newer version/)
    .first()
    .waitFor({
      timeout: 60_000,
    });
  await row(page).scrollIntoViewIfNeeded();
  step(`harnesses:\n${await list.innerText()}`);
  await shoot(page, "05-harnesses");

  // Never sign in for the user: a Harness the session needs must already be ready.
  for (const kind of prompt === null ? [] : sessionHarnesses) {
    const status = await list.getByTestId(`harness-${kind}`).innerText();

    if (!/\bReady\b/.test(status)) throw new Error(`${kind} isn't ready on ${alias}: ${status}`);
  }
};

/** One short Turn on `kind` from the new-session page, until the session is Idle again. */
const session = async (page: Page, kind: string, text: string) => {
  await page.keyboard.press("Meta+N");
  await page.getByTestId("new-session").waitFor({ timeout: 10_000 });
  step(`where: ${await page.getByTestId("where-line").innerText()}`);
  await page.getByTestId(`harness-${kind}`).click();
  await page.getByTestId("composer-input").fill(text);
  await shoot(page, `09-${kind}-prompt`);
  const started = Date.now();

  await page.getByTestId("composer-input").press("Enter");
  // Earlier sessions stay mounted, hidden, for instant switching: only the visible one counts.
  const state = page.locator('[data-testid="session-state"]:visible');
  const deadline = Date.now() + 5 * 60_000;

  await page.waitForTimeout(2000);

  while (!/^(Idle|Needs you|Failed)/.test(await state.innerText())) {
    if (Date.now() > deadline) throw new Error(`${kind} session still ${await state.innerText()}`);
    await page.waitForTimeout(1000);
  }

  const items = [await page.locator('[data-testid="session-panel"]:visible').innerText()];

  await shoot(page, `10-${kind}-done`);
  const ended = await state.innerText();

  step(`${kind} session: ${ended} in ${Math.round((Date.now() - started) / 1000)} s`);
  step(`${kind} items:\n${items.join("\n---\n").slice(0, 1200)}`);

  if (!ended.startsWith("Idle")) throw new Error(`${kind} session ended ${ended}`);
};

/** Leaves Settings, selects the Host, and opens its home directory with ⌘O, as a user does. */
const workspace = async (page: Page, homeDir: string | null) => {
  if (homeDir === null) throw new Error("no home directory reported");
  await page.keyboard.press("Escape");
  // The Workspace bar's host label (the machine bar's button from 11 Workspaces).
  await page.locator(`button[data-host="${alias}"]`).first().click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Meta+O");
  await page.getByTestId("folder-path").waitFor({ timeout: 10_000 });

  const selected = await page
    .locator('[role="dialog"] [data-slot="segmented-control"] [data-state="on"]')
    .innerText();

  step(`⌘O opened on ${selected.trim()}`);
  // Its home is where it starts; the listing comes over the Host's own Daemon.
  const open = page.getByTestId("folder-open");

  await open.waitFor({ timeout: 30_000 });
  step(`⌘O lists ${homeDir}:\n${await page.locator("[cmdk-list]").innerText()}`);
  await shoot(page, "06-open-folder");
  await page.keyboard.press("Enter");
  await page.getByTestId("folder-path").waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForTimeout(800);
  step(`workspace ${homeDir} open on ${alias}`);
  await shoot(page, "07-workspace");
  await page.keyboard.press("Meta+N");
  await page.waitForTimeout(1500);
  await shoot(page, "08-new-session");
  step(`new session page:\n${(await page.locator("main").last().innerText()).slice(0, 800)}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: null });
  await addHost(page);
  const found = await machine(page, "offer", 120_000);

  step(`probe: step ${found.install?.step}, state ${found.status?.state}`);
  await approve(page, found);
  const connected = await machine(page, "connected", 120_000);
  await row(page).scrollIntoViewIfNeeded();
  await shoot(page, "04-connected");
  await harnesses(page);

  await workspace(page, connected.status?.host?.homeDir ?? null);

  for (const kind of prompt === null ? [] : sessionHarnesses) await session(page, kind, prompt!);
} catch (error) {
  await app.windows()[0]?.screenshot({ path: join(dir, "failure.png") });
  console.error(
    `real: FAILED ${String(error)}\n${await app.windows()[0]?.locator("body").innerText()}`
  );
  process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
