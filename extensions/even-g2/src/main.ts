// Portions adapted from even-realities/evenhub-templates@8cb01354 (MIT)
/** Starts the app in the Even app's WebView: the phone page and the glasses. */
import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createPolarisWith } from "@polaris/sdk";
import { startApp } from "./app/controller.ts";
import { captureConsole, connectionLog } from "./app/log.ts";
import { loggedTransport } from "./app/transport.ts";
import { evenGlasses } from "./glasses/bridge.ts";
import { mountPhonePage } from "./phone/page.ts";
import { addPairing, loadPairings, savePairings, type Stored } from "./phone/pairings.ts";
import { scanPairing } from "./phone/scan.ts";

const CLIENT_NAME = "Even G2";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) throw new Error("index.html has no #app");

const log = connectionLog();

captureConsole(log);

log.add(`started, ${location.origin}`);

const bridge = await waitForEvenAppBridge();

const app = startApp({
  glasses: evenGlasses(bridge),
  connect: (pairings) =>
    createPolarisWith(
      { pairings, clientName: CLIENT_NAME, computerUse: true },
      loggedTransport(log.add)
    ),
  onHosts: (hosts) => phone.showHosts(hosts),
  log: log.add,
});

const texts = (stored: ReadonlyArray<Stored>) => stored.map((entry) => entry.text);

const initial = (): ReadonlyArray<Stored> => {
  const stored = loadPairings(localStorage);
  const dev = import.meta.env.DEV ? import.meta.env.VITE_POLARIS_PAIRING : undefined;

  if (stored.length > 0 || dev === undefined) return stored;
  const seeded = addPairing(stored, dev);

  return seeded.ok ? seeded.stored : stored;
};

const phone = mountPhonePage(root, {
  stored: initial(),
  onChange: (stored) => {
    savePairings(localStorage, stored);
    void app.pair(texts(stored));
  },
  scan: () => scanPairing(bridge),
});

log.onChange(() => phone.showLog(log.lines()));

phone.showLog(log.lines());

void app.pair(texts(initial()));

// Sockets may be dropped while the WebView is in the background.
let hiddenAt: number | null = null;

document.addEventListener("visibilitychange", () => {
  log.add(`the page is ${document.visibilityState}`);

  if (document.visibilityState === "hidden") hiddenAt = Date.now();
  else if (hiddenAt !== null) {
    hiddenAt = null;
    void app.reconnect();
  }
});
