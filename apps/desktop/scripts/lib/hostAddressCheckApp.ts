/**
 * The Electron side of scripts/hostAddressCheck.ts: connects to one Host as the Desktop App
 * does, sets up a Workspace's Browser partition, loads each URL and prints what it found.
 */
import { spawnSync } from "node:child_process";
import { Effect, ManagedRuntime, Schema } from "effect";
import { app, BrowserWindow, session } from "electron";
import { createHostAddresses } from "../../src/main/hostAddress/index.ts";
import { browserPartition } from "../../src/main/browser/views.ts";
import { openThroughHost } from "../../src/main/hostAddress/open.ts";
import { distrustInSession } from "../../src/main/tls/distrust.ts";
import { clientIdentity, HostDirectory, remoteEntry, whenConnected } from "../../src/main/hosts.ts";

interface CheckConfig {
  readonly alias: string;
  readonly remoteCommand: string;
  readonly urls: ReadonlyArray<string>;
  /** A Vite page on the Host, and the sed edit on the Host that HMR must apply without a reload. */
  readonly hmr: {
    readonly url: string;
    readonly file: string;
    readonly from: string;
    readonly to: string;
  } | null;
}

// SAFETY: the driver always passes this JSON, built from a CheckConfig.
const config = JSON.parse(process.env.POLARIS_HOST_ADDRESS_CHECK ?? "") as CheckConfig;

const report = (result: Readonly<Record<string, string | number | boolean>>) =>
  console.log(`check: ${JSON.stringify(result)}`);

const PageState = Schema.Struct({
  origin: Schema.String,
  title: Schema.String,
  text: Schema.String,
  marker: Schema.Boolean,
});

const decodePageState = Schema.decodeUnknownPromise(PageState);

const pageState = async (win: BrowserWindow) =>
  decodePageState(
    await win.webContents.executeJavaScript(
      "({ origin: location.origin, title: document.title, text: document.body.innerText.slice(0, 120), marker: window.__check === 1 })"
    )
  );

const load = async (win: BrowserWindow, url: string) => {
  try {
    await win.loadURL(url);

    return { url, ok: true, ...(await pageState(win)) };
  } catch (error) {
    return { url, ok: false, error: String(error).slice(0, 160) };
  }
};

/**
 * Resolves once the next page's Vite client says its HMR WebSocket is connected. Counting only
 * after `did-navigate`: the page being replaced can still log its own late "connected.".
 */
const viteConnected = (win: BrowserWindow) =>
  new Promise<void>((resolve) => {
    let committed = false;

    const navigated = () => {
      committed = true;
    };

    const listen = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      if (!committed || !event.message.includes("[vite] connected.")) return;
      win.webContents.off("console-message", listen);
      resolve();
    };

    win.webContents.once("did-navigate", navigated);
    win.webContents.on("console-message", listen);
  });

const hmr = async (win: BrowserWindow, check: NonNullable<CheckConfig["hmr"]>) => {
  const connected = viteConnected(win);

  await win.loadURL(check.url);
  await connected;
  await win.webContents.executeJavaScript("window.__check = 1");
  const before = await pageState(win);

  const edit = (from: string, to: string) =>
    spawnSync("ssh", [config.alias, `sed -i 's/${from}/${to}/' ${check.file}`], {
      stdio: "inherit",
    });

  edit(check.from, check.to);

  try {
    for (let i = 0; i < 50; i++) {
      const after = await pageState(win);

      if (after.text.includes(check.to))
        return { hmr: true, reloaded: !after.marker, before: before.text, after: after.text };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return { hmr: false, before: before.text };
  } finally {
    edit(check.to, check.from);
  }
};

app.commandLine.appendSwitch("use-mock-keychain");

const main = async () => {
  await app.whenReady();

  const runtime = ManagedRuntime.make(
    HostDirectory.layer({
      entries: [remoteEntry({ alias: config.alias, remoteCommand: config.remoteCommand })],
      identity: clientIdentity("0.0.0-host-address-check"),
    })
  );

  await runtime.runPromise(Effect.timeout(whenConnected(config.alias), "30 seconds"));
  report({ connected: config.alias });

  const hostAddresses = createHostAddresses({
    isLocal: () => false,
    open: openThroughHost,
    run: (effect) => runtime.runFork(effect),
  });

  const partition = session.fromPartition(browserPartition(config.alias, "check"));

  // As src/main/index.ts answers the proxy's challenge.
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    const credentials = hostAddresses.proxyLogin(webContents?.session, authInfo);

    report({ login: credentials !== null, isProxy: authInfo.isProxy, port: authInfo.port });

    if (credentials === null) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  });

  // As browser/views.ts sets a partition up before it asks for Host addresses.
  distrustInSession(partition);
  await hostAddresses.configureBrowserSession(config.alias, partition);
  const win = new BrowserWindow({ show: false, webPreferences: { session: partition } });

  win.webContents.on("console-message", ({ message }) => {
    if (message.startsWith("[vite]")) report({ console: message });
  });

  for (const url of config.urls) report(await load(win, url));

  if (config.hmr !== null) report(await hmr(win, config.hmr));

  // With the Host's proxy stopped, a Host address must fail, never load from this Mac.
  await hostAddresses.forget(config.alias);
  report({ afterForget: true, ...(await load(win, config.urls[0] ?? "http://localhost/")) });
  win.destroy();
  await hostAddresses.dispose();
  await runtime.dispose();
};

main()
  .catch((error: Error) => report({ failed: error.message }))
  .finally(() => app.exit(0));
