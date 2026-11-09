#!/usr/bin/env node
/**
 * Requests end to end on a real Daemon (ENG-809): a traced invoices app over SQLite, its
 * `http/invoices.http`, sends from Requests and from an agent, Origin Approvals, and Traces'
 * Resend, in Moonlit and light. Needs a built app and port 4329 free.
 *
 *   node scripts/requestsLiveScreens.ts <out dir>
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { SAMPLE_TOKEN, startSampleApp, writeSampleApp } from "./lib/requestsSampleApp.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-requests-live");
// Short paths: the Daemon's Unix socket lives under its home.

const home = "/tmp/pr809";

const checkout = "/tmp/pr809app";

const ports = { traced: 4801, untraced: 4802 };

mkdirSync(out, { recursive: true });

rmSync(home, { recursive: true, force: true });

mkdirSync(home, { recursive: true });

writeSampleApp(checkout, ports);

const appPath = realpathSync(checkout);

const daemon = await startDaemon({
  home: join(home, "local"),
  benchHarness: true,
  env: { POLARIS_TRACE_PORT: "4329", POLARIS_GATEWAY_PORT: "0" },
});

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const IDLE = `bench:${JSON.stringify({ items: 1, deltasPerItem: 1, deltaIntervalMs: 1 })}`;

/** Registers the checkout, starts an idle bench session in it and reads its trace endpoint. */
const seed = (path: string) => `(async () => {
  const api = window.polaris;
  const must = (result, what) => {
    if (!result.ok) throw new Error(what + ": " + result.error.code + " " + result.error.message);
    return result.value;
  };
  const dispatch = (command) =>
    api.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command })
      .then((r) => must(r, command._tag));
  await dispatch({ _tag: "RegisterWorkspace", path: ${JSON.stringify(path)}, name: "invoices" });
  const workspaceId = await new Promise((resolve) => {
    const close = api.subscribe("host", { hostKey: "local" }, { items: (items) => {
      for (const i of items) {
        const all = i._tag === "Snapshot" ? i.workspaces
          : i._tag === "Event" && i.envelope.event._tag === "WorkspaceRegistered" ? [i.envelope.event.workspace] : [];
        const found = all.find((w) => w.path === ${JSON.stringify(path)});
        if (found) { close(); resolve(found.id); return; }
      }
    } });
  });
  const sessionId = crypto.randomUUID();
  await dispatch({
    _tag: "StartSession", sessionId, workspaceId, harness: "claude",
    placement: { _tag: "InPlace" }, permissionMode: "supervised", model: null, effort: null,
    prompt: ${JSON.stringify(IDLE)}, attachments: [],
  });
  await dispatch({ _tag: "RenameSession", sessionId, title: "Check invoices" });
  const endpoint = await new Promise((resolve) => {
    const close = api.subscribe("traces.watch", { hostKey: "local", sessionId }, { items: (items) => {
      for (const s of items) if (s.endpoint) { close(); resolve(s.endpoint); return; }
    } });
  });
  return { sessionId, endpoint };
})()`;

const themes = ["dark", "light"] as const;

const setTheme = async (page: Page, theme: (typeof themes)[number]) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  await page.mouse.move(1300, 860);
  await page.waitForTimeout(700);
};

/** Saves `name` in both themes, ending on dark. */
const shoot = async (page: Page, name: string) => {
  for (const theme of themes) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  }

  await setTheme(page, "dark");
  console.log(`requests-live: saved ${name}`);
};

/** Waits for `locator`; on a timeout, saves what the window showed and its text. */
const see = async (
  page: Page,
  locator: ReturnType<Page["locator"]>,
  label: string,
  timeout = 20_000
) => {
  try {
    await locator.waitFor({ timeout });
  } catch (error) {
    await page.screenshot({ path: join(out, `fail-${label}.png`) });
    console.error(
      `requests-live: ${label} not seen; window text:\n${await page.locator("body").innerText()}`
    );
    throw error;
  }
};

let traced: Awaited<ReturnType<typeof startSampleApp>> | null = null;

let untraced: Awaited<ReturnType<typeof startSampleApp>> | null = null;

/** Runs `send_request` as the bench agent (`polaris tool …`) and returns the tool's result. */
interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
}

/** send_request's input: a saved Request by file and name, or an inline one. */
interface SendRequestInput {
  readonly file?: string;
  readonly name?: string;
  readonly environment?: string;
  readonly method?: string;
  readonly url?: string;
  readonly body?: string;
}

const agentTool = (page: Page, sessionId: string, input: SendRequestInput): Promise<ToolResult> =>
  page.evaluate<ToolResult>(`(async () => {
    const api = window.polaris;
    const sessionId = ${JSON.stringify(sessionId)};
    const seen = new Set();
    let ready = false;
    const result = new Promise((resolve) => {
      const close = api.subscribe("session", { hostKey: "local", sessionId, turnLimit: null }, { items: (items) => {
        for (const i of items) {
          const e = i._tag === "Event" ? i.envelope.event : null;
          if (e === null || e._tag !== "TurnItemCompleted" || e.item._tag !== "ToolCall") continue;
          if (!ready) { seen.add(e.item.id); continue; }
          if (seen.has(e.item.id)) continue;
          close();
          resolve({ isError: e.item.output.isError, text: e.item.output.content.map((c) => c.text ?? "").join("\\n") });
        }
      } });
    });
    await new Promise((r) => setTimeout(r, 1000));
    ready = true;
    const sent = await api.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: {
      _tag: "SendTurn", sessionId, attachments: [],
      prompt: "polaris tool send_request " + ${JSON.stringify(JSON.stringify(input))},
    } });
    if (!sent.ok) throw new Error(sent.error.message);
    return result;
  })()`);

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  // SAFETY: the seed source returns this shape.
  const seeded = (await page.evaluate(seed(appPath))) as { sessionId: string; endpoint: string };

  console.log(
    `requests-live: session ${seeded.sessionId}, endpoint on ${new URL(seeded.endpoint).port}`
  );
  traced = await startSampleApp(appPath, ports.traced, seeded.endpoint);

  await page.locator('[data-slot="chip"]', { hasText: "invoices" }).first().click();
  await page.getByText("Check invoices", { exact: true }).first().click();
  await page.keyboard.press("Meta+6");
  await page.getByTestId("requests-mode").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await shoot(page, "live-list");

  // 1. Edit in place, save, send.
  const url = page.getByTestId("requests-url");

  await url.click();
  await url.press("End");
  await url.pressSequentially("&limit=5");
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(1000);
  const saved = readFileSync(join(appPath, "http/invoices.http"), "utf8");

  if (!saved.includes("GET {{base}}/invoices?customer=1&limit=5\n"))
    throw new Error(`the edit was not saved in place:\n${saved}`);
  console.log("requests-live: saved the edit in place");
  await page.keyboard.press("Meta+Enter");
  await see(
    page,
    page.locator('section[aria-label="Trace"]').getByText("GET /invoices").first(),
    "trace"
  );
  await page.waitForTimeout(1500);
  await shoot(page, "live-sent");

  // 1. The POST writes: DATA lists invoices as wrote.
  await page.getByText("Create invoice", { exact: true }).first().click();
  await page.keyboard.press("Meta+Enter");
  const data = page.locator('section[aria-label="Data"]');

  await see(page, data.getByText("wrote").first(), "wrote");
  await see(
    page,
    page.locator('section[aria-label="Trace"]').getByText("INSERT invoices").first(),
    "insert-span"
  );
  await page.waitForTimeout(1000);
  await shoot(page, "live-post");

  // Open in Traces lands on this send's trace.
  const traceId = (await page.locator('section[aria-label="Trace"]').innerText()).match(
    /spans? · (\S+)/
  )?.[1];

  await page.getByRole("button", { name: /Open in Traces/ }).click();
  await see(page, page.getByTestId("traces-mode"), "traces-mode");
  await see(
    page,
    page.getByTestId("traces-mode").getByText("INSERT invoices").first(),
    "traces-span"
  );
  await page.waitForTimeout(800);
  await shoot(page, "live-open-in-traces");
  console.log(`requests-live: Open in Traces showed ${traceId}`);

  // Open in Data lands on the invoices table, with the new row.
  await page.keyboard.press("Meta+6");
  await see(page, data.getByText("invoices", { exact: true }), "data-row");
  await data.getByText("invoices", { exact: true }).click();
  await page.getByRole("button", { name: /Open in Data/ }).click();
  await see(page, page.getByTestId("data-mode"), "data-mode");
  await see(
    page,
    page
      .getByTestId("data-mode")
      .getByText(/^4\s?200$/)
      .first(),
    "data-new-row"
  );
  await page.waitForTimeout(800);
  await shoot(page, "live-open-in-data");

  // 2. The send log shows both sends; selecting the GET reloads it.
  await page.keyboard.press("Meta+6");
  await page
    .getByTestId("requests-sidebar")
    .getByRole("radio", { name: /Send log/ })
    .click();
  const rows = page.getByTestId("requests-send-row");

  await see(page, rows.nth(1), "send-log-rows");
  await rows.filter({ hasText: "GET" }).first().click();
  await see(page, page.locator('input[aria-label="URL"][value*="limit=5"]'), "send-log-reload");
  await see(
    page,
    page.locator('section[aria-label="Trace"]').getByText("SELECT invoices").first(),
    "send-log-trace"
  );
  await page.waitForTimeout(800);
  await shoot(page, "live-send-log");

  // 6. The send's trace in Traces offers Resend, which loads the request.
  await page.getByRole("button", { name: /Open in Traces/ }).click();
  await see(page, page.getByRole("button", { name: /Resend in Requests/ }), "resend");
  await page.waitForTimeout(800);
  await shoot(page, "live-resend-offer");
  await page.getByRole("button", { name: /Resend in Requests/ }).click();
  await see(page, page.locator('input[aria-label="URL"][value*="limit=5"]'), "resend-loaded");
  await page.waitForTimeout(800);
  await shoot(page, "live-resend-loaded");

  // 3. With the server stopped, a send is refused.
  await page
    .getByTestId("requests-sidebar")
    .getByRole("radio", { name: /^Requests/ })
    .click();
  await page.getByText("List invoices", { exact: true }).first().click();
  await traced.stop();
  traced = null;
  await page.keyboard.press("Meta+Enter");
  await see(page, page.getByText(/refused/i).first(), "refused");
  await see(
    page,
    page.locator('section[aria-label="Trace"]').getByText("send", { exact: true }),
    "refused-trace"
  );

  if ((await page.getByTestId("requests-no-spans").count()) > 0)
    throw new Error("a refused send blames the server's tracing");
  await page.waitForTimeout(800);
  await shoot(page, "live-refused");

  // 3. An app without tracing: no spans.
  untraced = await startSampleApp(appPath, ports.untraced, null);
  await page.getByTestId("requests-environment").click();
  await page.getByRole("menuitem", { name: "untraced" }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.getByTestId("requests-send").click();
  await see(page, page.getByTestId("send-status").filter({ hasText: "200" }), "untraced-200");
  await see(page, page.getByTestId("requests-no-spans"), "no-spans", 30_000);
  await page.waitForTimeout(800);
  await shoot(page, "live-no-spans");
  await untraced.stop();
  untraced = null;
  traced = await startSampleApp(appPath, ports.traced, seeded.endpoint);

  // 4. An agent's send_request to the local app: no approval, a traceId, no token.
  const local = await agentTool(page, seeded.sessionId, {
    file: "http/invoices.http",
    name: "List invoices",
    environment: "dev",
  });

  console.log(`requests-live: agent local send:\n${local.text}`);

  if (local.isError || !/trace/i.test(local.text))
    throw new Error("the agent's local send failed or had no traceId");

  if (local.text.includes(SAMPLE_TOKEN)) throw new Error("the token reached the agent");
  await page.keyboard.press("Meta+6");
  await page
    .getByTestId("requests-sidebar")
    .getByRole("radio", { name: /Send log/ })
    .click();
  await see(
    page,
    page.getByTestId("requests-send-row").filter({ hasText: "Check invoices" }).first(),
    "agent-row"
  );
  await page.getByTestId("requests-send-row").filter({ hasText: "Check invoices" }).first().click();
  await see(
    page,
    page.getByTestId("requests-environment").filter({ hasText: "dev" }),
    "agent-send-env"
  );
  await page.waitForTimeout(1500);
  await shoot(page, "live-agent-send");

  // 5. A remote origin asks; Approve with reads: the GET goes, a POST is denied.
  const remote = agentTool(page, seeded.sessionId, { method: "GET", url: "https://example.com/" });

  remote.catch(() => {});

  await see(page, page.getByTestId("origin-approval").first(), "approval-in-requests", 30_000);
  await page.waitForTimeout(800);
  await shoot(page, "live-approval-requests");
  await page.keyboard.press("Meta+1");
  await see(page, page.getByTestId("origin-approval").first(), "approval-in-thread");
  await page.waitForTimeout(800);
  await shoot(page, "live-approval-thread");
  await page.getByTestId("origin-approval").first().getByText("Reads only").click();
  await page
    .getByTestId("origin-approval")
    .first()
    .getByRole("button", { name: "Approve" })
    .click();
  const got = await remote;

  console.log(`requests-live: agent remote GET:\n${got.text}`);

  if (got.isError) throw new Error("the approved GET failed");
  // The remembered reads rule doesn't cover a POST: it asks again, and Reads only denies it.

  const posting = agentTool(page, seeded.sessionId, {
    method: "POST",
    url: "https://example.com/",
    body: "{}",
  });

  posting.catch(() => {});
  const card = page.getByTestId("origin-approval").filter({ hasText: "a write" }).last();

  await see(page, card.getByRole("button", { name: "Approve" }), "post-approval", 30_000);
  await page.waitForTimeout(800);
  await shoot(page, "live-approval-post");
  await card.locator("label", { hasText: "GET, HEAD, OPTIONS" }).click({ timeout: 10_000 });
  await card.getByRole("button", { name: "Approve" }).click({ timeout: 10_000 });

  const post = await Promise.race([
    posting,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the POST never answered")), 70_000)
    ),
  ]).catch(async (error) => {
    await page.screenshot({ path: join(out, "fail-post.png") });
    console.error(await page.locator("body").innerText());
    throw error;
  });

  console.log(`requests-live: agent remote POST:\n${post.text}`);

  if (!post.isError || !/denied/i.test(post.text)) throw new Error("the POST was not denied");
  await page.keyboard.press("Meta+6");
  await page.waitForTimeout(1500);
  await shoot(page, "live-remote-sends");
} finally {
  await untraced?.stop();
  await traced?.stop();
  await app.close();
  await daemon.stop();
}
