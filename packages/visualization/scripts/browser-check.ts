#!/usr/bin/env bun
/**
 * Runs frame documents in real Chrome, in `<iframe sandbox="allow-scripts" srcdoc>` as the Desktop
 * App does: the CSP blocks egress, heights arrive, pv:theme applies live, the examples render, and
 * each frame's own guard empties its closed shadow roots (happy-dom shares one guard across frames).
 *
 *   bun scripts/browser-check.ts [--chrome <path>] [--shots <dir>]
 *
 * The documents skip validation on purpose: the CSP must hold for a fragment validation missed.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { chromium } from "playwright-core";
import { VISUALIZATION_EXAMPLES } from "../examples/index.ts";
import { buildFrameDocument, type FrameDocumentOptions } from "../src/index.ts";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);

  return at === -1 ? undefined : process.argv[at + 1];
};

const chromePath =
  flag("--chrome") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const shots = flag("--shots");

const hits: Array<string> = [];

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/") return new Response(HOST_PAGE, { headers: { "content-type": "text/html" } });

    if (path === "/favicon.ico") return new Response(null, { status: 404 });
    hits.push(path);

    return new Response("x", { headers: { "access-control-allow-origin": "*" } });
  },
});

const origin = `http://127.0.0.1:${server.port}`;

let stunPackets = 0;

const stun = await Bun.udpSocket({ socket: { data: () => void (stunPackets += 1) } });

const HOST_PAGE = `<!doctype html><html><body style="margin:0;background:#1a1b1d">
<script>
  window.messages = [];
  window.addEventListener("message", (event) => {
    const frame = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === event.source);
    window.messages.push({ frame: frame ? frame.id : null, data: event.data });
  });
  window.mount = (id, srcdoc, width) => {
    const frame = document.createElement("iframe");
    frame.id = id;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "display:block;border:0;width:" + width + "px;height:200px;margin-bottom:8px";
    frame.srcdoc = srcdoc;
    document.body.appendChild(frame);
  };
  window.setHeight = (id, height) => { document.getElementById(id).style.height = height + "px"; };
  window.isOpaque = (id) => document.getElementById(id).contentDocument === null;
  window.sendTheme = (id, message) => document.getElementById(id).contentWindow.postMessage(message, "*");
</script></body></html>`;

const doc = (html: string, overrides: Partial<FrameDocumentOptions> = {}): string =>
  buildFrameDocument({
    html,
    title: "check",
    tokens: {},
    scheme: "dark",
    mode: "inline",
    ...overrides,
  });

/** A nested frame that runs its own WebRTC: a fresh realm the bootstrap's block doesn't reach. */
const rtcChild = (label: string) =>
  `<script>try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stun.port}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)); parent.parent.postMessage({ check: "egress", what: "${label} ran" }, "*"); } catch (e) {}</script>`;

const EGRESS = `<img src="${origin}/img"><link rel="stylesheet" href="${origin}/css">
<div style="background:url(${origin}/bg);width:10px;height:10px"></div>
<style>@import url("${origin}/import"); @font-face { font-family: x; src: url(${origin}/font); } body { font-family: x; }</style>
<iframe src="${origin}/iframe"></iframe><object data="${origin}/object"></object>
<iframe srcdoc="${rtcChild("parser child").replaceAll('"', "&quot;")}"></iframe>
<form id="f" action="${origin}/form" method="post"><input name="q" value="secret"></form>
<script>
  const s = "agent const";
  const report = (what) => parent.postMessage({ check: "egress", what }, "*");
  document.addEventListener("securitypolicyviolation", (e) => report("blocked " + e.violatedDirective));
  fetch("${origin}/fetch").then(() => report("fetch ok"), () => report("fetch blocked"));
  try { const ws = new WebSocket("${origin.replace("http", "ws")}/ws"); ws.onerror = () => report("ws blocked"); } catch (e) { report("ws threw"); }
  navigator.sendBeacon && navigator.sendBeacon("${origin}/beacon", "x");
  new Image().src = "${origin}/image";
  const ice = { iceServers: [{ urls: "stun:127.0.0.1:${stun.port}" }] };
  const rtc = (Peer, label) => {
    try {
      const pc = new Peer(ice);
      pc.createDataChannel("x");
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
      report(label + " constructed");
    } catch (e) { report(label + " blocked"); }
  };
  rtc(window.RTCPeerConnection, "rtc");
  const own = document.createElement("iframe");
  own.srcdoc = ${JSON.stringify(rtcChild("script child")).replaceAll("</", "<\\/")};
  document.body.appendChild(own);
  const nested = ${JSON.stringify(rtcChild("shadow child")).replaceAll("</", "<\\/")};
  const shadow = document.createElement("div");
  document.body.appendChild(shadow);
  const inShadow = document.createElement("iframe");
  inShadow.srcdoc = nested;
  shadow.attachShadow({ mode: "closed" }).appendChild(inShadow);
  const dsd = '<div><template shadowrootmode="closed"><iframe srcdoc="' + nested.replaceAll('"', "&quot;") + '"></iframe></template></div>';
  try { document.write(dsd); } catch (e) { report("document.write threw"); }
  try { shadow.setHTMLUnsafe(dsd); } catch (e) { report("setHTMLUnsafe threw"); }
  const child = document.createElement("iframe");
  document.body.appendChild(child);
  try { rtc(child.contentWindow.RTCPeerConnection, "rtc via child frame"); } catch (e) { report("rtc via child frame blocked"); }
  try { document.getElementById("f").submit(); } catch (e) { report("form threw"); }
  parent.postMessage({ check: "egress", what: "script ran:" + s + ":" + typeof pv.chart }, "*");
</script>`;

const GROWING = `<div id="box" style="height:150px">tall</div>
<script>setTimeout(() => { document.getElementById("box").style.height = "420px"; }, 300);
setTimeout(() => { document.getElementById("box").style.height = "90px"; }, 700);</script>`;

const THEMED = `<div id="c" style="height:120px"></div><script>
  const chart = pv.chart("#c", { type: "bar", data: { labels: ["a"], datasets: [{ label: "x", data: [1] }] } });
  window.addEventListener("pv:theme", () => parent.postMessage({ check: "theme",
    background: getComputedStyle(document.documentElement).getPropertyValue("--pv-bg").trim(),
    chartColour: Chart.defaults.color, dataset: chart.data.datasets[0].backgroundColor, scheme: pv.scheme }, "*"));
</script>`;

/** Closed shadow roots the guard must empty; the script keeps each root, so it can count. */
const SHADOW_SCRIPT = `<script>
  const host = () => document.body.appendChild(document.createElement("div"));
  const plain = host().attachShadow({ mode: "closed" });
  plain.appendChild(document.createElement("iframe"));
  const has = WeakSet.prototype.has;
  WeakSet.prototype.has = () => true;
  const poisoned = host().attachShadow({ mode: "closed" });
  poisoned.appendChild(document.createElement("iframe"));
  WeakSet.prototype.has = has;
  const cloned = host();
  cloned.attachShadow({ mode: "closed", clonable: true, serializable: true }).innerHTML = "<p>private</p>";
  let fresh = false;
  try { fresh = cloned.cloneNode(true).attachShadow({ mode: "closed" }).childNodes.length === 0; } catch (e) {}
  setTimeout(() => parent.postMessage({ check: "shadow", shadow: {
    plain: plain.querySelectorAll("iframe").length,
    poisoned: poisoned.querySelectorAll("iframe").length,
    fresh,
  } }, "*"), 100);
</script>`;

const browser = await chromium.launch({ executablePath: chromePath, headless: true });

const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });

await page.goto(origin);

const mountOn = (target: typeof page, id: string, srcdoc: string, width: number) =>
  target.evaluate(`mount(${JSON.stringify(id)}, ${JSON.stringify(srcdoc)}, ${width})`);

const mount = (id: string, srcdoc: string, width = 728) => mountOn(page, id, srcdoc, width);

const Recorded = Schema.Array(
  Schema.Struct({
    frame: Schema.NullOr(Schema.String),
    data: Schema.Struct({
      type: Schema.optional(Schema.String),
      height: Schema.optional(Schema.Number),
      check: Schema.optional(Schema.String),
      what: Schema.optional(Schema.String),
      background: Schema.optional(Schema.String),
      dataset: Schema.optional(Schema.String),
      scheme: Schema.optional(Schema.String),
      shadow: Schema.optional(
        Schema.Struct({ plain: Schema.Number, poisoned: Schema.Number, fresh: Schema.Boolean })
      ),
    }),
  })
);

const recorded = async (target: typeof page) =>
  Schema.decodeUnknownSync(Recorded)(await target.evaluate("messages"));

await mount("egress", doc(EGRESS, { mode: "expanded" }));

await mount("growing", doc(GROWING));

await mount("themed", doc(THEMED, { scheme: "dark" }));

// Two guarded frames, each checked against its own guard, and a bare one that shows the check bites.
for (const id of ["shadow-1", "shadow-2"])
  await mount(id, doc(SHADOW_SCRIPT, { mode: "expanded" }));

await mount("shadow-bare", `<!doctype html><body>${SHADOW_SCRIPT}</body>`);

for (const [name, example] of Object.entries(VISUALIZATION_EXAMPLES)) {
  for (const width of [360, 728])
    await mount(`${name}@${width}`, doc(example.html, { title: example.title }), width);
}

await page.waitForTimeout(1500);

const THEME = {
  type: "pv:theme",
  scheme: "light",
  tokens: { "--pv-bg": "#fafafa", "--pv-series-1": "#010203", "--pv-track": "x<y" },
};

await page.evaluate(`sendTheme("themed", ${JSON.stringify(THEME)})`);

await page.waitForTimeout(500);

const messages = await recorded(page);

const from = (id: string) => messages.filter((m) => m.frame === id).map((m) => m.data);

const heights = (id: string) => from(id).flatMap((d) => (d.height === undefined ? [] : [d.height]));

const results: Array<readonly [string, boolean, string]> = [];

const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
};

const egress = from("egress").map((d) => d.what);

check("no request reached the server", hits.length === 0, JSON.stringify(hits));

check(
  "the agent's const s ran beside the bootstrap",
  egress.includes("script ran:agent const:function"),
  JSON.stringify(egress)
);

check("fetch was blocked", egress.includes("fetch blocked"), JSON.stringify(egress));

check("WebRTC can't be constructed", egress.includes("rtc blocked"), JSON.stringify(egress));

check(
  "document.write and setHTMLUnsafe are refused",
  egress.includes("document.write threw") && egress.includes("setHTMLUnsafe threw"),
  JSON.stringify(egress)
);

check(
  "nested srcdoc frames never ran (inserted, scripted, in a closed shadow root)",
  !messages.some((m) => m.data.what?.endsWith("child ran")),
  JSON.stringify(messages.filter((m) => m.frame === null))
);

check(
  "no STUN packet left the frame (WebRTC, also via a child frame)",
  stunPackets === 0,
  JSON.stringify({ stunPackets, egress })
);

const shadowOf = (id: string) => from(id).find((d) => d.check === "shadow")?.shadow;

for (const id of ["shadow-1", "shadow-2"]) {
  const seen = shadowOf(id);

  check(
    `${id}: its guard empties closed shadow roots (also with WeakSet.has poisoned), clones stay fresh`,
    seen?.plain === 0 && seen.poisoned === 0 && seen.fresh,
    JSON.stringify(seen)
  );
}

check(
  "without the bootstrap, the same closed shadow roots keep their frames",
  shadowOf("shadow-bare")?.plain === 1,
  JSON.stringify(shadowOf("shadow-bare"))
);

const growing = heights("growing");

check(
  "inline height (content + 2 × 16px padding) reported, grows and shrinks",
  growing.includes(150 + 32) && growing.includes(420 + 32) && growing.at(-1) === 90 + 32,
  JSON.stringify(growing)
);

const theme = from("themed").find((d) => d.check === "theme");

check(
  "pv:theme applied live",
  theme?.background === "#fafafa" && theme.dataset === "#010203" && theme.scheme === "light",
  JSON.stringify(theme)
);

for (const name of Object.keys(VISUALIZATION_EXAMPLES)) {
  for (const width of [360, 728]) {
    const id = `${name}@${width}`;

    const opaque = Schema.decodeUnknownSync(Schema.Boolean)(
      await page.evaluate(`isOpaque(${JSON.stringify(id)})`)
    );

    check(
      `${id} is opaque-origin and reported a height`,
      opaque && heights(id).length > 0,
      JSON.stringify(heights(id))
    );
  }
}

if (shots !== undefined) {
  mkdirSync(shots, { recursive: true });

  for (const [name, example] of Object.entries(VISUALIZATION_EXAMPLES)) {
    for (const width of [360, 728]) {
      const shot = await browser.newPage({ viewport: { width: 760, height: 1200 } });
      await shot.goto(origin);
      await mountOn(shot, "f", doc(example.html, { title: example.title }), width);
      await shot.waitForTimeout(800);

      const last = (await recorded(shot)).flatMap((m) => m.data.height ?? []).at(-1) ?? 200;

      await shot.evaluate(`setHeight("f", ${Math.min(last, 1100)})`);
      await shot.waitForTimeout(200);
      await shot.locator("#f").screenshot({ path: join(shots, `${name}@${width}.png`) });
      await shot.close();
    }
  }
}

await browser.close();

await server.stop(true);

stun.close();

for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);

const failed = results.filter(([, ok]) => !ok).length;

console.log(`${results.length - failed}/${results.length} checks passed`);

process.exit(failed === 0 ? 0 : 1);
