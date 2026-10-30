/**
 * The Settings gate's checks beyond screenshots (ENG-573, ENG-564): Reduce Motion stills the
 * Hosts sparklines, the reach map's packets and the composer's Working dither; Tab walks a page
 * in reading order with focus visible; a confirm-in-place holds focus on Cancel and esc cancels it.
 */
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { seedSource } from "./seed.ts";

/** Each Host's relay route and phones (`used`: it opened a session 30 s ago, so it is live). */
const RELAY = [
  { hostKey: "local", state: "off", connected: false, phones: [] },
  {
    hostKey: "studio",
    state: "on",
    connected: true,
    phones: [
      { id: "d-1", name: "Lucas's iPhone", noiseKey: "k1", used: true },
      { id: "d-2", name: "Even G2", noiseKey: "k2", used: false },
    ],
  },
  {
    hostKey: "vm",
    state: "on",
    connected: true,
    phones: [{ id: "d-3", name: "Lucas's iPhone", noiseKey: "k1", used: true }],
  },
  {
    hostKey: "pi",
    state: "on",
    connected: false,
    phones: [{ id: "d-4", name: "Lucas's iPhone", noiseKey: "k1", used: false }],
  },
];

interface Envelope {
  readonly method: string;
  readonly input: { readonly hostKey?: string };
}

/** Electron's invoke event, passed through untouched. */
type InvokeEvent = Electron.IpcMainInvokeEvent;

type Handler = (event: InvokeEvent, message: Envelope) => Promise<object>;

interface InvokeHandlers {
  readonly _invokeHandlers: Map<string, Handler>;
}

/**
 * Answers Devices' requests in the main process from RELAY: Mac Studio and Linux VM have the
 * relay on with a phone live, the Pi's relay is connecting, This Mac's is off. The rest go through.
 */
export const stubDevices = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }, relay) => {
    const channel = "polaris:request";
    // SAFETY: Electron keeps ipcMain.handle's handlers in this map; the stub forwards to the original.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- an Electron internal with no public type
    const original = (ipcMain as unknown as InvokeHandlers)._invokeHandlers.get(channel);

    if (original === undefined) throw new Error("no request handler");

    const used = new Date(Date.now() - 30_000).toISOString();

    const answer = (message: Envelope) => {
      const host = relay.find((h) => h.hostKey === message.input.hostKey);

      if (host === undefined) return null;

      if (message.method === "relayRoute.status")
        return {
          state: host.state,
          connected: host.connected,
          url: host.state === "on" ? "wss://relay.lux.dev/v1" : null,
          hostAddress: `host-${host.hostKey}`,
          hostNoiseKey: `noise-${host.hostKey}`,
        };

      if (message.method === "devices.list")
        return host.phones.map((p) => ({
          id: p.id,
          name: p.name,
          noiseKey: p.noiseKey,
          relayAddress: `relay-${p.noiseKey}`,
          createdAt: "2026-10-20T12:00:00.000Z",
          lastUsedAt: p.used ? used : null,
          unlinkedAt: null,
        }));

      return null;
    };

    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, message: Envelope): Promise<object> => {
      const value = answer(message);

      return value === null ? original(event, message) : Promise.resolve({ ok: true, value });
    });
  }, RELAY);

/** Two pairings on Mac Studio and one on This Mac, through the app's bridge. */
export const PAIR = `(async () => {
  const pair = (hostKey, name, grant) => window.polaris.request("extensions.pair", { hostKey, name, grant });
  await pair("studio", "Raycast", ["read", "approve", "turn"]);
  await pair("studio", "Even G2 glasses", ["read", "approve"]);
  await pair("local", "Phone shortcuts", ["read"]);
})()`;

interface ChecksInput {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly nav: (name: string) => Promise<void>;
  readonly shoot: (page: Page, name: string) => Promise<void>;
  readonly setAppearance: (page: Page, patch: Readonly<Record<string, string>>) => Promise<void>;
}

/** What `still` reads of an element in the page: a canvas has `toDataURL`. */
interface Pixels {
  readonly tagName: string;
  readonly toDataURL?: () => string;
}

/**
 * Whether every element looks the same twice, `gap` ms apart: a canvas by its own pixels (text
 * over it, like the strip's elapsed time, doesn't count), anything else by a screenshot.
 */
const still = async (elements: Locator, gap = 1_000) => {
  const count = await elements.count();

  if (count === 0) return "absent";

  const frame = async (element: Locator) => {
    const url = await element.evaluate((el: Pixels) =>
      el.tagName === "CANVAS" && el.toDataURL !== undefined ? el.toDataURL() : null
    );

    return url === null ? element.screenshot() : Buffer.from(url);
  };

  const frames = async () =>
    Promise.all(Array.from({ length: count }, (_, i) => frame(elements.nth(i))));

  const first = await frames();

  await elements.page().waitForTimeout(gap);
  const second = await frames();

  return first.every((buffer, i) => buffer.equals(second[i] ?? Buffer.alloc(0)))
    ? "still"
    : "moving";
};

const motionChecks = async ({ page, nav, setAppearance }: ChecksInput) => {
  const report = async (what: string, open: () => Promise<Locator>, gap?: number) => {
    const results: Array<string> = [];

    for (const motion of ["full", "reduce"]) {
      await setAppearance(page, { motion });
      const elements = await open();

      results.push(`${motion}: ${await still(elements, gap)}`);
    }

    console.log(`motion: ${what}: ${results.join(", ")}`);
  };

  await report(
    "hosts sparklines",
    async () => {
      await nav("Hosts");
      await page.waitForTimeout(5_000);

      return page.getByTestId("sparkline");
      // Samples come every ~2 s: two frames 3 s apart straddle one.
    },
    3_000
  );
  await report("reach map packets", async () => {
    await nav("Devices");
    await page.getByTestId("reach-map").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1_500);

    return page.getByTestId("reach-map");
  });
};

/** Each Tab stop: what it is, where it sits, and whether a focus ring shows. */
const TAB_STOP = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
  const by = (el.getAttribute("aria-labelledby") || "").split(" ").map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
  const label = el.labels && el.labels[0] ? el.labels[0].textContent : "";
  const named = el.getAttribute("aria-label") || by || label || el.textContent || el.getAttribute("placeholder") || el.getAttribute("title");
  const name = (named || "UNNAMED " + el.tagName).trim().replace(/\\s+/g, " ").slice(0, 40);
  const inPage = !!el.closest("[data-section]");
  return { name, role: el.getAttribute("role") || el.tagName.toLowerCase(), x: Math.round(r.x), y: Math.round(r.y), ring, inPage };
})()`;

interface Stop {
  readonly name: string;
  readonly role: string;
  readonly x: number;
  readonly y: number;
  readonly ring: boolean;
  readonly inPage: boolean;
}

const tabWalk = async (page: Page, label: string, shoot: ChecksInput["shoot"], stops = 40) => {
  await page.evaluate(`document.querySelector("[data-section]").scrollTo(0, 0)`);
  await page.locator("[data-section] h1, [data-section] h2").first().click({ force: true });

  const seen: Array<Stop> = [];

  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    // SAFETY: TAB_STOP returns a Stop or null.
    const stop = (await page.evaluate(TAB_STOP)) as Stop | null;

    if (stop === null) continue;

    if (i === 2 || i === 8) await shoot(page, `keys-${label}-tab${i + 1}`);

    if (seen.length > 0 && seen[0]?.name === stop.name && seen[0].y === stop.y) break;
    seen.push(stop);
  }

  const inPage = seen.filter((s) => s.inPage);
  const unringed = inPage.flatMap((s) => (s.ring ? [] : [s.name]));

  // Reading order: top to bottom, left to right within a row (12px slack).
  const backwards = inPage.flatMap((s, i) => {
    const prev = inPage[i - 1];

    const before =
      prev !== undefined &&
      (s.y < prev.y - 12 || (Math.abs(s.y - prev.y) <= 12 && s.x < prev.x - 4));

    return before ? [`${prev.name} → ${s.name}`] : [];
  });

  console.log(
    `keys: ${label}: ${inPage.length} stops in the page; no visible ring: ${unringed.join(" | ") || "none"}; out of reading order: ${backwards.join(" | ") || "none"}`
  );
  console.log(`keys: ${label}: order ${inPage.map((s) => s.name).join(" › ")}`);
};

/** Revoke on Extensions: the row confirms in place, Cancel holds focus, esc cancels it. */
const confirmInPlace = async ({ page, nav, shoot }: ChecksInput) => {
  await nav("Extensions");
  const row = page.getByTestId("pairing-row").first();

  await row.getByRole("button", { name: /^Revoke/ }).click();
  await page.waitForTimeout(300);
  const focused = String(await page.evaluate("document.activeElement?.textContent?.trim()"));

  await shoot(page, "keys-extensions-revoke-confirm");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const open = await page.getByTestId("settings").count();
  const stillConfirming = await row.getByRole("button", { name: "Cancel" }).count();

  console.log(
    `keys: revoke confirm: focus on "${focused}"; after esc settings ${open === 1 ? "open" : "closed"}, confirm ${stillConfirming === 0 ? "cancelled" : "still showing"}`
  );
};

/** The composer's Working dither, in a bench session, with motion full and reduced. */
const ditherCheck = async ({ page, setAppearance }: ChecksInput) => {
  await page.keyboard.press("Escape");
  await page.getByTestId("settings").waitFor({ state: "detached", timeout: 5_000 });
  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "polaris",
        sessions: [{ title: "Dither check", state: "working" }],
      },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "polaris" }).first().click();
  await page.getByText("Dither check", { exact: true }).first().click();
  await page.locator('[data-slot="working-strip"]').waitFor({ timeout: 20_000 });
  const results: Array<string> = [];

  for (const motion of ["full", "reduce"]) {
    await setAppearance(page, { motion });
    await page.waitForTimeout(600);
    results.push(`${motion}: ${await still(page.locator('[data-slot="working-strip"] canvas'))}`);
  }

  console.log(`motion: composer working dither: ${results.join(", ")}`);
};

export const settingsChecks = async (input: ChecksInput) => {
  const { page, nav, shoot } = input;

  for (const [label, name] of [
    ["sessions", "Sessions"],
    ["attachments", "Attachments"],
    ["extensions", "Extensions"],
  ] as const) {
    await nav(name);
    await page.waitForTimeout(800);
    await tabWalk(page, label, shoot);
  }

  await nav("Hosts");
  await page.getByTestId("machine-local").getByRole("button").first().click();
  await page.getByTestId("host-page").waitFor({ timeout: 10_000 });
  await tabWalk(page, "host-page", shoot);
  await page.keyboard.press("Escape");
  await confirmInPlace(input);
  await motionChecks(input);
  await ditherCheck(input);
  await input.setAppearance(page, { motion: "system" });
};
