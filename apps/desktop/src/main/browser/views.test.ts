import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

const Outcome = Schema.fromJsonString(
  Schema.Struct({
    loaded: Schema.Array(Schema.String),
    routed: Schema.Boolean,
    contents: Schema.Boolean,
  })
);

const here = (path: string) => JSON.stringify(new URL(path, import.meta.url).pathname);

/**
 * Runs `electronViews` in a child Bun with `electron` mocked, through `scenario`. The page records
 * every `loadURL`; `setups` holds each partition setup, in order, for the scenario to settle.
 */
const throughViews = (scenario: string) => {
  const source = `
    import { mock } from "bun:test";
    const loaded = [];
    const anything = new Proxy({}, { get: () => () => {} });
    mock.module("electron", () => ({
      session: { fromPartition: () => anything },
      WebContentsView: class {
        webContents = new Proxy({
          loadURL: async (url) => void loaded.push(url),
          getURL: () => "",
          isDestroyed: () => false,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        }, { get: (target, key) => target[key] ?? (() => {}) });
        setVisible() {}
      },
    }));
    const { electronViews } = await import(${here("./views.ts")});
    const setups = [];
    const views = electronViews({
      window: () => null,
      configureSession: () => {
        const setup = Promise.withResolvers();
        setups.push(setup);
        return setup.promise;
      },
      onChange: () => {},
      onPopup: () => {},
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    ${scenario}
    await tick();
    const routed = views.routing.isRouted("tab-1");
    const contents = views.contentsOf("tab-1") !== null;
    console.log(JSON.stringify({ loaded: loaded.map((url) => url.startsWith("data:") ? "failure page" : url), routed, contents }));
  `;

  const child = Bun.spawnSync([process.execPath, "-e", source], {
    cwd: new URL(".", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });

  return Schema.decodeUnknownSync(Outcome)(child.stdout.toString().trim().split("\n").at(-1));
};

describe("a Host removed while a tab sets up, then added again", () => {
  const removedAndAdded = `
    views.host.create({ tabId: "tab-1", url: "http://localhost:3000/" }, { hostKey: "rpi", workspaceId: "w" });
    await tick();
    views.retireHost("rpi");
    views.host.reload("tab-1", false);
    await tick();
  `;

  test.each([
    [
      "before",
      `setups[0].reject(new Error("rpi was removed")); await tick(); setups[1]?.resolve();`,
    ],
    [
      "after",
      `setups[1]?.resolve(); await tick(); setups[0].reject(new Error("rpi was removed"));`,
    ],
  ])(
    "the stale setup failing %s the new one succeeds leaves the new load in place and the tab routed",
    (_, settle) => {
      const outcome = throughViews(`${removedAndAdded} ${settle}`);

      expect(outcome).toEqual({
        loaded: ["failure page", "http://localhost:3000/"],
        routed: true,
        contents: true,
      });
    }
  );
});
