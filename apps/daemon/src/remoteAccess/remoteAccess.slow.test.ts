import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import { RemoteAccess, RemoteAccessLive } from "../extensions/remoteAccess.ts";
import { runTailscaleCommand } from "./cli.ts";
import { makeRemoteAccess, RemoteAccessControl } from "./index.ts";
import { findTailscale, MACOS_APP_CLI } from "./tailscale.ts";
import { startGateway as startDaemonGateway } from "../gateway/index.ts";

const HOST = "mac.tail1234.ts.net";

const FAKE = join(import.meta.dir, "fixtures", "fake-tailscale.ts");

let dir: string;

/** The fake CLI's environment: its directory on PATH and its state directory. */
type FakeEnv = {
  readonly PATH: string;
  readonly FAKE_TAILSCALE_DIR: string;
};

let env: FakeEnv;

let gateway: ReturnType<typeof Bun.serve>;

const decodeChallenge = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ challenge: Schema.String }))
);

/** The gateway's proof as ENG-399 specifies it: HMAC-SHA256 over the decoded bytes, base64url. */
const macOf = (secret: string, challenge: string) =>
  createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(Buffer.from(challenge, "base64url"))
    .digest("base64url");

const newSecret = () => randomBytes(32).toString("base64url");

/** A loopback server answering `POST /polaris/identity`'s challenge with `answer`. */
const serveIdentity = (answer: (challenge: string) => string) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      new URL(request.url).pathname === "/polaris/identity" && request.method === "POST"
        ? Response.json({ mac: answer(decodeChallenge(await request.text()).challenge) })
        : new Response(null, { status: 404 }),
  });

const record = (port: number | undefined, secret: string) =>
  writeFileSync(join(dir, "gateway.json"), JSON.stringify({ port, secret }));

/** Starts a gateway and records it in `gateway.json`, as the Daemon does on each start. */
const startGateway = (secret = newSecret()) => {
  void gateway?.stop(true);
  gateway = serveIdentity((challenge) => macOf(secret, challenge));
  record(gateway.port, secret);

  return gateway.port;
};

const status = (overrides: { BackendState?: string; Self?: object } = {}) =>
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: `${HOST}.`, CapMap: { https: null, funnel: null } },
      ...overrides,
    })
  );

const decodeCall = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ args: Schema.Array(Schema.String) }))
);

const decodeServe = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      Web: Schema.Record(
        Schema.String,
        Schema.Struct({
          Handlers: Schema.Record(Schema.String, Schema.Struct({ Proxy: Schema.String })),
        })
      ),
    })
  )
);

const calls = (): ReadonlyArray<ReadonlyArray<string>> =>
  readFileSync(join(dir, "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeCall(line).args);

const serveCalls = () => calls().filter((args) => args[0] === "serve" && args[1] !== "status");

const handlers = () =>
  decodeServe(readFileSync(join(dir, "serve.json"), "utf8")).Web[`${HOST}:443`]?.Handlers;

const remoteAccess = (os = "darwin") =>
  makeRemoteAccess({ root: dir, os, findCli: () => findTailscale(env, os, () => false) });

// The fake Tailscale CLI is a shell script, which Windows can't run from PATH.
const windows = process.platform === "win32";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pol-ts-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, "tailscale"), 0o755);
  writeFileSync(join(dir, "calls.log"), "");
  env = { PATH: bin, FAKE_TAILSCALE_DIR: dir };
  status();
  startGateway();
});

afterEach(() => {
  void gateway.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(windows)("findTailscale", () => {
  test("uses the CLI on PATH, else the macOS app's binary as a CLI, else none", () => {
    expect(findTailscale(env, "darwin", () => true)?.path).toBe(join(dir, "bin", "tailscale"));

    const app = findTailscale({ PATH: "/nonexistent" }, "darwin", (path) => path === MACOS_APP_CLI);
    expect(app?.path).toBe(MACOS_APP_CLI);
    expect(app?.env.TAILSCALE_BE_CLI).toBe("1");

    expect(findTailscale({ PATH: "/nonexistent" }, "linux", () => true)).toBeNull();
    expect(findTailscale({ PATH: "/nonexistent" }, "darwin", () => false)).toBeNull();
  });
});

describe.skipIf(windows)("Remote Access", () => {
  test.each([
    ["text", "/polaris", { Text: "hello" }],
    ["file", "/polaris", { Path: "/srv/file.txt" }],
    ["directory", "/polaris/", { Path: "/srv/files" }],
  ] as const)(
    "a %s handler reads as exposed and off removes only that mount",
    async (_, mount, handler) => {
      writeFileSync(
        join(dir, "serve.json"),
        JSON.stringify({
          Web: {
            [`${HOST}:443`]: {
              Handlers: { [mount]: handler, "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        })
      );
      const access = remoteAccess();

      expect(await Effect.runPromise(access.status)).toMatchObject({
        state: "on",
        url: null,
        reason: "serving-elsewhere",
      });
      expect(await Effect.runPromise(access.disable)).toMatchObject({ state: "off", url: null });
      expect(handlers()).toEqual({ "/": { Proxy: "http://127.0.0.1:3773" } });
    }
  );

  test.each(["not json", '{"Web":[]}', '{"Web":{"bad":null}}'])(
    "unreadable serve output %s never reads as off or allows enable",
    async (json) => {
      writeFileSync(join(dir, "serve.json"), json);
      const access = remoteAccess();

      expect(await Effect.runPromise(access.status)).toMatchObject({
        state: "unavailable",
        reason: "failed",
      });
      expect((await Effect.runPromise(Effect.flip(access.enable))).reason).toBe("failed");
      expect(serveCalls()).toEqual([]);
    }
  );

  test.each([false, true])(
    "Funnel is preserved and never published as a pairing URL (Polaris served: %s)",
    async (served) => {
      const port = startGateway();

      const configuredHandlers = new Map([["/", { Proxy: "http://127.0.0.1:3773" }]]);

      if (served) configuredHandlers.set("/polaris", { Proxy: `http://127.0.0.1:${port}/polaris` });

      const config = JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        AllowFunnel: { [`${HOST}:443`]: true },
        Web: {
          [`${HOST}:443`]: {
            Handlers: Object.fromEntries(configuredHandlers),
          },
        },
      });

      writeFileSync(join(dir, "serve.json"), config);
      const access = remoteAccess();

      expect(await Effect.runPromise(access.status)).toMatchObject({
        state: served ? "on" : "off",
        reason: "funnel-on",
        url: null,
      });
      expect((await Effect.runPromise(Effect.flip(access.enable))).reason).toBe("funnel-on");
      expect(readFileSync(join(dir, "serve.json"), "utf8")).toBe(config);
      expect(serveCalls()).toEqual([]);

      if (served) {
        expect(await Effect.runPromise(access.disable)).toMatchObject({
          state: "off",
          reason: "funnel-on",
        });
        expect(JSON.parse(readFileSync(join(dir, "serve.json"), "utf8"))).toEqual({
          TCP: { "443": { HTTPS: true } },
          AllowFunnel: { [`${HOST}:443`]: true },
          Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } } },
        });
      }
    }
  );

  test.each(["foreground", "http"] as const)(
    "a %s listener on 443 is preserved, including when Polaris is already served",
    async (kind) => {
      const port = startGateway();

      const occupied =
        kind === "foreground"
          ? {
              Foreground: {
                session: {
                  TCP: { "443": { HTTPS: true } },
                  Web: {
                    [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
                  },
                },
              },
            }
          : { TCP: { "443": { HTTP: true } } };

      for (const served of [false, true]) {
        const config = JSON.stringify({
          ...occupied,
          Web: {
            [`${HOST}:443`]: {
              Handlers: served
                ? { "/polaris": { Proxy: `http://127.0.0.1:${port}/polaris` } }
                : { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        });

        writeFileSync(join(dir, "serve.json"), config);
        const access = remoteAccess();

        expect(await Effect.runPromise(access.status)).toMatchObject(
          served
            ? { state: "on", reason: null, url: `wss://${HOST}/polaris/rpc` }
            : { state: "unavailable", reason: "port-in-use", url: null }
        );
        expect((await Effect.runPromise(Effect.flip(access.enable))).reason).toBe("port-in-use");
        expect((await Effect.runPromise(Effect.flip(access.disable))).reason).toBe("port-in-use");
        expect(readFileSync(join(dir, "serve.json"), "utf8")).toBe(config);
        expect(serveCalls()).toEqual([]);
      }
    }
  );

  test("a redirect to a gateway holding the secret does not prove the recorded port", async () => {
    const secret = newSecret();
    const real = serveIdentity((challenge) => macOf(secret, challenge));

    void gateway.stop(true);
    gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(`http://127.0.0.1:${real.port}/polaris/identity`, 307),
    });
    record(gateway.port, secret);

    try {
      const access = remoteAccess();

      expect((await Effect.runPromise(Effect.flip(access.enable))).reason).toBe(
        "gateway-not-running"
      );
      expect(serveCalls()).toEqual([]);
    } finally {
      void real.stop(true);
    }
  });

  test("turning on serves the gateway's path with the prefix put back, then reports its URL", async () => {
    const port = startGateway();
    const access = remoteAccess();

    expect((await Effect.runPromise(access.status)).state).toBe("off");

    const on = await Effect.runPromise(access.enable);

    expect(serveCalls()).toEqual([
      [
        "serve",
        "--bg",
        "--https=443",
        "--set-path",
        "/polaris",
        `http://127.0.0.1:${port}/polaris`,
      ],
    ]);
    expect(on).toMatchObject({
      state: "on",
      url: `wss://${HOST}/polaris/rpc`,
      hostName: HOST,
      reason: null,
    });
  });

  test("turning off removes only Polaris's path, and off again is fine", async () => {
    writeFileSync(
      join(dir, "serve.json"),
      JSON.stringify({
        Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } } },
      })
    );
    const access = remoteAccess();
    await Effect.runPromise(access.enable);

    const off = await Effect.runPromise(access.disable);

    expect(off).toMatchObject({ state: "off", url: null });
    expect(handlers()).toEqual({ "/": { Proxy: "http://127.0.0.1:3773" } });
    expect((await Effect.runPromise(access.disable)).state).toBe("off");
  });

  test("a path still proxying to an old gateway port reads as exposed, and on replaces it", async () => {
    const access = remoteAccess();

    await Effect.runPromise(access.enable);
    const port = startGateway();

    expect(await Effect.runPromise(access.status)).toMatchObject({
      state: "on",
      url: null,
      reason: "serving-elsewhere",
    });
    await Effect.runPromise(access.enable);
    expect(handlers()?.["/polaris"]).toEqual({ Proxy: `http://127.0.0.1:${port}/polaris` });
  });

  test("the Daemon's own gateway proves itself, and is served", async () => {
    void gateway.stop(true);
    rmSync(join(dir, "gateway.json"));

    const port = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const real = yield* startDaemonGateway({
            port: 0,
            recordPath: join(dir, "gateway.json"),
          });

          yield* Effect.promise(() => Effect.runPromise(remoteAccess().enable));

          return real?.port;
        })
      )
    );

    expect(handlers()?.["/polaris"]).toEqual({ Proxy: `http://127.0.0.1:${port}/polaris` });
  });

  test("a gateway that stopped leaves its path exposed until turned off, never reading as off", async () => {
    const access = remoteAccess();

    await Effect.runPromise(access.enable);
    rmSync(join(dir, "gateway.json"));

    expect(await Effect.runPromise(access.status)).toMatchObject({
      state: "on",
      url: null,
      reason: "gateway-not-running",
    });
    expect(await Effect.runPromise(access.disable)).toMatchObject({
      state: "off",
      reason: "gateway-not-running",
    });
    expect(handlers()).toEqual({});
  });

  test.each([
    ["no gateway is recorded", () => rmSync(join(dir, "gateway.json"))],
    [
      "another process holds the gateway's port",
      () => {
        const theirs = newSecret();

        void gateway.stop(true);
        gateway = serveIdentity((challenge) => macOf(theirs, challenge));
        record(gateway.port, newSecret());
      },
    ],
    [
      "another process replays a proof it saw",
      () => {
        const secret = newSecret();
        const seen = macOf(secret, newSecret());

        void gateway.stop(true);
        gateway = serveIdentity(() => seen);
        record(gateway.port, secret);
      },
    ],
  ] as const)("when %s, it is off and is never served to the tailnet", async (_, arrange) => {
    arrange();
    const access = remoteAccess();

    expect(await Effect.runPromise(access.status)).toMatchObject({
      state: "off",
      url: null,
      reason: "gateway-not-running",
    });
    expect((await Effect.runPromise(Effect.flip(access.enable))).reason).toBe(
      "gateway-not-running"
    );
    expect(serveCalls()).toEqual([]);
  });

  test.each([
    ["logged out", { BackendState: "NeedsLogin" }, "not-logged-in"],
    ["stopped", { BackendState: "Stopped" }, "not-running"],
    [
      "without HTTPS certificates",
      { Self: { DNSName: `${HOST}.`, CapMap: { funnel: null } } },
      "https-disabled",
    ],
    ["without MagicDNS", { Self: { DNSName: "", CapMap: { https: null } } }, "https-disabled"],
  ] as const)(
    "Tailscale %s is unavailable and is never asked to serve",
    async (_, overrides, reason) => {
      status(overrides);
      const access = remoteAccess();

      expect(await Effect.runPromise(access.status)).toMatchObject({
        state: "unavailable",
        reason,
      });
      const error = await Effect.runPromise(Effect.flip(access.enable));
      expect(error.reason).toBe(reason);
      // `serve` without HTTPS waits on a prompt; it must not be started.
      expect(serveCalls()).toEqual([]);
    }
  );

  test("Tailscale's stderr is classified and never repeated, even when it holds an auth key", async () => {
    writeFileSync(
      join(dir, "status.fail"),
      "failed to connect to local Tailscale daemon tskey-auth-k123SECRET\n"
    );
    const access = remoteAccess();

    const answer = await Effect.runPromise(access.status);
    const error = await Effect.runPromise(Effect.flip(access.enable));

    expect(answer).toMatchObject({ state: "unavailable", reason: "not-running" });
    expect(JSON.stringify([answer, error, error.message])).not.toContain("tskey");
  });

  test("a refused serve is needs-operator on Linux, where the user must be the operator", async () => {
    writeFileSync(
      join(dir, "serve.fail"),
      "Access denied: serve config denied\nUse 'sudo tailscale set --operator=$USER'\n"
    );

    expect((await Effect.runPromise(Effect.flip(remoteAccess("linux").enable))).reason).toBe(
      "needs-operator"
    );
    expect((await Effect.runPromise(Effect.flip(remoteAccess("darwin").enable))).reason).toBe(
      "failed"
    );
  });

  test("without Tailscale it is unavailable, and off has nothing to remove", async () => {
    const access = makeRemoteAccess({ root: dir, findCli: () => null });

    expect(await Effect.runPromise(access.status)).toMatchObject({ reason: "not-installed" });
    expect(await Effect.runPromise(access.disable)).toMatchObject({ reason: "not-installed" });
  });

  test("the pairing string's URL follows Remote Access", async () => {
    const control = remoteAccess();

    const url = Effect.flatMap(RemoteAccess, (access) => access.url).pipe(
      Effect.provide(RemoteAccessLive),
      Effect.provideService(RemoteAccessControl, control)
    );

    expect(await Effect.runPromise(url)).toEqual(Option.none());
    await Effect.runPromise(control.enable);
    expect(await Effect.runPromise(url)).toEqual(Option.some(`wss://${HOST}/polaris/rpc`));
  });
});

describe.skipIf(windows)("polaris tailscale", () => {
  const run = async (args: ReadonlyArray<string>) => {
    const lines: Array<string> = [];

    const code = await runTailscaleCommand(
      args,
      { root: dir, os: "darwin", findCli: () => findTailscale(env, "darwin", () => false) },
      (line) => lines.push(line),
      (line) => lines.push(line)
    );

    return { code, output: lines.join("\n") };
  };

  test("on, status and off say where Extensions connect, and fail with a reason", async () => {
    expect(await run(["on"])).toEqual({
      code: 0,
      output: `Remote access is on: https://${HOST}/polaris\nExtensions connect to wss://${HOST}/polaris/rpc`,
    });
    expect((await run(["status"])).code).toBe(0);
    expect((await run(["off"])).output).toBe(
      "Remote access is off. Turn it on with `polaris tailscale on`."
    );

    status({ BackendState: "NeedsLogin" });
    expect(await run(["on"])).toEqual({
      code: 1,
      output: "polaris tailscale: Tailscale isn't logged in on this host.",
    });
    expect((await run(["status"])).code).toBe(1);
    expect((await run([])).code).toBe(2);
  });
});
