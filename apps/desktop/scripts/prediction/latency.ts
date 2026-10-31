/** Real Electron keystrokes, IPC, Host context and shared inference; never manages model servers. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { startDaemon } from "../lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
  sizeWindow,
} from "../lib/electron.ts";
import { Snapshot, summarizeLatency, type LatencySample } from "./summary.ts";
import { modelServerMemory } from "../lib/modelServerMemory.ts";

const label = process.argv[2] ?? "after";

const out = join(REPO_ROOT, ".dagr/evidence/tlat", label);

mkdirSync(out, { recursive: true });

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-tlat-")));

const userData = join(home, "user-data");

const project = join(home, "project");

for (const path of [userData, project]) mkdirSync(path);

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    welcomeSeen: true,
    predictionEnabled: true,
    predictionConfigured: true,
    predictionClientEndpoints: [{ kind: "openai", url: "http://127.0.0.1:8080" }],
  })
);

const fixtures = [
  "function add(a: number, b: number) {\n  return",
  'const names = ["Ada", "Grace"];\nconst count =',
  "function greet(name: string) {",
];

writeFileSync(join(project, "latency.txt"), fixtures[0] ?? "");

const samples: LatencySample[] = [];

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

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
  page.on("pageerror", (error) => console.error(error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await sizeWindow(app, 1280, 860);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey:"local",commandId:crypto.randomUUID(),command:{_tag:"RegisterWorkspace",path:${JSON.stringify(project)},name:"tlat-proof"}})`
  );
  await page
    .getByRole("button", { name: /tlat-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill("latency.txt");
  await page.getByTestId("finder-item").first().waitFor();
  await page.keyboard.press("Enter");
  const editor = page.locator(".cm-content").first();
  await editor.waitFor();
  await page
    .getByTestId("prediction-status")
    .waitFor({ timeout: 15000 })
    .catch(() => undefined);
  await page.evaluate(`(() => {
    window.tlatPainted = 0;
    new MutationObserver(() => {
      if (!window.tlatPainted && document.querySelector('.cm-prediction-inline'))
        requestAnimationFrame(() => { if (!window.tlatPainted) window.tlatPainted = performance.now(); });
    }).observe(document.body, { childList: true, subtree: true });
  })()`);

  for (let fixture = 0; fixture < fixtures.length; fixture++) {
    for (let repeat = 0; repeat < 7; repeat++) {
      await editor.click();
      await page.keyboard.press("Meta+A");
      await page.keyboard.insertText(fixtures[fixture] ?? "");
      await page.keyboard.press("Escape");

      for (const key of [" ", "a"]) {
        await page.evaluate(
          `(() => { for (const mark of performance.getEntriesByType('mark')) if (mark.name.startsWith('polaris.prediction.')) performance.clearMarks(mark.name); window.tlatPainted = 0; })()`
        );
        await page.keyboard.insertText(key);
        await page
          .locator(".cm-prediction-inline")
          .waitFor({ timeout: 20_000 })
          .catch(async (error) => {
            console.log(await page.locator("body").innerText());
            console.log(
              await page.evaluate(
                `performance.getEntriesByType("mark").map(m => ({name:m.name, detail:m.detail}))`
              )
            );
            await page.screenshot({ path: join(out, "failed.png") });
            throw error;
          });
        await page.locator(".cm-prediction-key").waitFor({ timeout: 20_000 });

        const snapshot = Schema.decodeUnknownSync(Snapshot)(
          await page.evaluate(`({
          marks: performance.getEntriesByType('mark').filter(m => m.name.startsWith('polaris.prediction.')).map(m => ({ name:m.name, startTime:m.startTime, detail:m.detail })),
          text: document.querySelector('.cm-prediction-inline')?.textContent ?? '', painted: window.tlatPainted
        })`)
        );

        samples.push({ fixture, repeat, key, load: loadavg(), snapshot });
        console.log(fixture, repeat, JSON.stringify(key), snapshot.text);
        writeFileSync(join(out, "samples.json"), JSON.stringify(samples, null, 2));
      }
    }
  }

  const summary = summarizeLatency(samples);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));

  for (const theme of ["dark", "light"])
    for (const density of ["calm", "balanced", "compact"]) {
      await page.evaluate(
        `window.polaris.request("settings.setAppearance", {patch:{theme:${JSON.stringify(theme)},density:${JSON.stringify(density)}}})`
      );
      await page.locator(`html[data-theme="${theme}"]`).waitFor();
      await page.screenshot({ path: join(out, `${theme}-${density}.png`) });
    }

  await page.evaluate(
    `window.polaris.request("settings.setAppearance", {patch:{motion:"reduce",diffPalette:"cvd"}})`
  );
  await page.screenshot({ path: join(out, "reduce-motion-cvd.png") });
  writeFileSync(
    join(out, "model-servers.json"),
    JSON.stringify(await modelServerMemory(APP_DIR), null, 2)
  );
} finally {
  await app?.evaluate(({ app: instance }) => instance.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
