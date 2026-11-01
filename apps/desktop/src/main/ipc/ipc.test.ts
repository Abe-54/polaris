/**
 * The IPC contract against a stand-in HostDirectory: methods and feeds are
 * wired, untrusted input is decoded before anything runs, and failures cross
 * as `IpcError`s. The real path, end to end, is `scripts/smoke.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, SubscriptionRef } from "effect";
import type { BatchEntry, HostView } from "../../shared/api.ts";
import { RequestInputs } from "../../shared/contract.ts";
import { DEFAULT_SESSION_PREFS } from "../../shared/sessionPrefs.ts";
import { CommandId, CommandRejected } from "@polaris/protocol";
import { HostTarget } from "@polaris/client";
import {
  type ClientServices,
  HostDirectory,
  type HostEntry,
  toIpcError,
  UnknownHost,
} from "../hosts.ts";
import { HostAccess } from "@polaris/client/access";
import { LocalHost } from "../local/index.ts";
import { createGitHubFake } from "../../../scripts/lib/githubFake/index.ts";
import { SecureStorage } from "../secure/index.ts";
import { GitHub } from "../github/index.ts";
import { Machines } from "../machines/service.ts";
import { type RequestContext, requestHandlers, requestRunner } from "./requests.ts";
import { windowSubscriptions } from "./subscriptions.ts";
import type { AppUpdateView } from "../../shared/appUpdates.ts";
import { PredictionOutcomes } from "../prediction/outcomes.ts";
import { PredictionSettings } from "../prediction/preferences.ts";
import type { Settings } from "../settings.ts";

const updateView: AppUpdateView = {
  phase: "idle",
  version: "0.1.0",
  availableVersion: null,
  automatic: true,
  lastCheckedAt: null,
  installId: "00000000-0000-4000-8000-000000000000",
  osVersion: "26.0",
  arch: "arm64",
  supported: false,
};

const view: HostView = {
  key: "local",
  label: "This Mac",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state: "reconnecting",
    failure: null,
    attempt: 1,
    since: 0,
    nextAttemptAt: null,
    host: null,
    capabilities: [],
    epoch: 0,
    latencyMs: null,
    lastSeenAt: null,
  },
};

const entryFor = (key: string, target: HostTarget): HostEntry => ({
  key,
  label: key,
  colour: null,
  alias: null,
  proofHarness: false,
  target,
  remoteCommand: null,
  simulatedLatencyMs: null,
});

const ENTRIES = new Map<string, HostEntry>([
  ["local", entryFor("local", HostTarget.Local({ socketPath: "/tmp/local.sock" }))],
  ["studio", entryFor("studio", HostTarget.Ssh({ alias: "studio" }))],
  ["Ubuntu", entryFor("Ubuntu", HostTarget.Wsl({ distro: "Ubuntu" }))],
]);

const directory = Layer.effect(
  HostDirectory,
  Effect.map(SubscriptionRef.make<ReadonlyArray<HostView>>([view]), (views) =>
    HostDirectory.of({
      views,
      entry: (key) => ENTRIES.get(key),
      connection: (key) => Effect.fail(new UnknownHost(key)),
      add: () => Effect.void,
      remove: () => Effect.void,
    })
  )
);

const clientServices = Layer.provideMerge(
  Machines.layer({
    settings: { get: () => ({ hosts: [{ alias: "studio" }] }), update: () => undefined },
    approvals: { approved: () => new Set(), approve: () => undefined, forget: () => undefined },
    builds: { source: "none", forPlatform: () => Effect.succeed([]) },
    aliases: () => [{ alias: "studio", hostName: null, user: null }],
    openTerminal: () => Promise.resolve(),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        HostAccess.test(() => Effect.die("no ssh in tests")),
        LocalHost.test()
      )
    )
  ),
  directory
);

const github = GitHub.layer({
  dir: mkdtempSync(join(tmpdir(), "polaris-ipc-github-")),
  fetch: createGitHubFake().fetch,
  endpoints: { web: "https://github.test", api: "https://api.github.test" },
}).pipe(Layer.provide(SecureStorage.memory));

const services = Layer.mergeAll(clientServices, github);

const revealed: Array<string> = [];

const context: RequestContext = {
  updates: {
    get: () => updateView,
    check: () => updateView,
    setAutomatic: (automatic) => ({ ...updateView, automatic }),
  },
  restartToUpdate: () => undefined,
  showAppInFinder: () => undefined,
  settings: () => ({ theme: "dark", hosts: [{ alias: "studio" }] }),
  cache: { get: () => [], put: () => undefined },
  prices: { table: () => Promise.reject(new Error("no prices in tests")) },
  setAppearance: () => undefined,
  setSessionDefault: () => undefined,
  setSessions: () => undefined,
  openExternal: () => Promise.resolve(),
  serveFrame: () => "app://polaris/frame/test",
  revealInFinder: (path) => void revealed.push(path),
  proofWorkspace: () => null,
  sshHosts: () => ["studio", "pi"],
  setWelcomeSeen: () => undefined,
  appVersion: "0.1.0",
  developmentBuild: false,
  pickFolder: () => Promise.resolve(null),
  writeClipboard: () => Promise.resolve(),
  writeSecretClipboard: async () => undefined,
  editAction: () => undefined,
  needsYou: () => undefined,
  showAppMenu: () => {},
};

const handlers = requestHandlers(context);

test("Prediction IPC queries and clears the same log and returns derived saved preferences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-prediction-ipc-"));
  const outcomes = new PredictionOutcomes(join(dir, "outcomes.jsonl"));
  let settings: Settings = {};

  const preferences = new PredictionSettings(
    () => settings,
    (next) => {
      settings = next;
    }
  );

  const predictionHandlers = requestHandlers({
    ...context,
    predictionOutcomes: outcomes,
    predictionSettings: preferences,
  });

  try {
    outcomes.keystrokes({ keystrokes: 12 });
    const metrics = await run(requestRunner(predictionHandlers, "prediction.metrics")({}));
    expect(Exit.isSuccess(metrics) && metrics.value).toMatchObject({ shown: 0, keystrokes: 12 });

    const saved = await run(
      requestRunner(
        predictionHandlers,
        "prediction.settings.set"
      )({
        hostKey: "local",
        preferences: { ...preferences.get("local"), aggressiveness: "conservative" },
      })
    );

    expect(Exit.isSuccess(saved) && saved.value).toMatchObject({
      aggressiveness: "conservative",
      restraints: {
        pauseMs: 300,
        jumpsOffered: false,
        jumpProbe: "off",
        largeDeletionsOffered: false,
      },
    });

    const loaded = await run(
      requestRunner(predictionHandlers, "prediction.settings.get")({ hostKey: "local" })
    );

    expect(Exit.isSuccess(loaded) && loaded.value).toEqual(Exit.isSuccess(saved) && saved.value);
    const cleared = await run(requestRunner(predictionHandlers, "prediction.outcomes.clear")({}));
    expect(Exit.isSuccess(cleared) && cleared.value).toBeNull();
    const empty = await run(requestRunner(predictionHandlers, "prediction.metrics")({}));
    expect(Exit.isSuccess(empty) && empty.value).toMatchObject({ shown: 0, keystrokes: 0 });
  } finally {
    await outcomes.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const run = <A, E>(effect: Effect.Effect<A, E, ClientServices>) =>
  ManagedRuntime.make(services).runPromiseExit(effect);

/** Waits until `ready` holds (up to 2 s): a loaded runner can take longer than a fixed sleep. */
const until = async (ready: () => boolean) => {
  for (let waited = 0; !ready() && waited < 2000; waited += 5) await Bun.sleep(5);
};

describe("requests", () => {
  test("installs go only through machines, which pick ssh, wsl.exe or the local shell", () => {
    expect(Object.keys(RequestInputs).filter((method) => method.startsWith("install."))).toEqual(
      []
    );
  });

  test("settings come back with their defaults filled in", async () => {
    const exit = await run(requestRunner(handlers, "settings.get")({}));

    expect(exit).toEqual(
      Exit.succeed({
        theme: "dark",
        darkTheme: "moonlit",
        density: "calm",
        textSize: "default",
        diffPalette: "default",
        motion: "system",
        codeFont: "sf-mono",
        codeFontSize: 13,
        wordWrap: false,
        sessionDefaults: {},
        sessions: DEFAULT_SESSION_PREFS,
        version: "0.1.0",
        developmentBuild: false,
        welcomeSeen: false,
        hosts: [{ alias: "studio", label: "studio", colour: null, forwardAgent: false }],
      })
    );
  });

  test("only https URLs open in the browser", async () => {
    const open = requestRunner(handlers, "shell.openExternal");

    expect(Exit.isSuccess(await run(open({ url: "https://opencode.ai/docs" })))).toBe(true);
    expect(Exit.isFailure(await run(open({ url: "file:///etc/passwd" })))).toBe(true);
  });

  test("Reveal in Finder works for this Mac's Host and a WSL distro's, never over ssh", async () => {
    const reveal = requestRunner(handlers, "shell.revealInFinder");

    expect(Exit.isSuccess(await run(reveal({ hostKey: "local", path: "/tmp/a.ts" })))).toBe(true);
    expect(Exit.isFailure(await run(reveal({ hostKey: "studio", path: "/tmp/a.ts" })))).toBe(true);
    expect(Exit.isSuccess(await run(reveal({ hostKey: "Ubuntu", path: "/home/a.ts" })))).toBe(true);
    expect(revealed).toEqual(["/tmp/a.ts", "\\\\wsl.localhost\\Ubuntu\\home\\a.ts"]);
  });

  test("onboarding.found lists the ssh config's Host aliases", async () => {
    const exit = await run(requestRunner(handlers, "onboarding.found")({}));

    expect(exit).toEqual(Exit.succeed({ sshHosts: ["studio", "pi"], version: "0.1.0" }));
  });

  test("a refusal crosses with the Daemon's reason as its message", () => {
    const refused = new CommandRejected({
      commandId: CommandId.make("c1"),
      reason: "interrupt the Turn in flight before archiving",
    });

    expect(toIpcError(refused)).toEqual({
      code: "CommandRejected",
      message: "interrupt the Turn in flight before archiving",
    });
  });

  test("an input that does not decode never reaches the handler", async () => {
    const exit = await run(requestRunner(handlers, "dispatch")({ hostKey: "local", command: {} }));

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidInput");
  });

  test.each([
    ["extensions.pair", { hostKey: "local", name: "Raycast", grant: ["read", "write"] }],
    ["extensions.pair", { hostKey: "local", name: 42, grant: ["read"] }],
    ["extensions.revoke", { hostKey: "local", id: 42 }],
    ["extensions.list", { hostKey: 42 }],
  ] as const)("invalid %s input is rejected before reaching the Host", async (method, input) => {
    const exit = await run(requestRunner(handlers, method)(input));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidInput");
  });

  test("an ssh alias that reads as an option never reaches ssh", async () => {
    const exit = await run(
      requestRunner(
        handlers,
        "machines.add"
      )({
        alias: "-oProxyCommand=evil",
        label: "x",
        colour: null,
        forwardAgent: false,
      })
    );

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidInput");
  });

  test("a Host that doesn't exist fails as an IpcError", async () => {
    const exit = await run(
      requestRunner(handlers, "files.stat")({ hostKey: "nowhere", path: "/" })
    );

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("UnknownHost");
  });
});

describe("github requests", () => {
  test("a pull request with no account signed in fails with no account", async () => {
    const exit = await run(
      requestRunner(
        handlers,
        "github.pull.detail"
      )({
        pull: { repo: { owner: "acme", name: "widgets" }, number: 42 },
      })
    );

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("GitHubNoAccount");
  });

  test("a repository name with a path in it is refused at the boundary", async () => {
    const exit = await run(
      requestRunner(handlers, "github.recheck")({ repo: { owner: "acme", name: "../../user" } })
    );

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidInput");
  });
});

describe("subscriptions", () => {
  const open = () => {
    const runtime = ManagedRuntime.make(services);
    const sent: Array<BatchEntry> = [];

    const subs = windowSubscriptions({
      runtime,
      target: { isDestroyed: () => false, send: (_channel, entries) => sent.push(...entries) },
    });

    return { sent, subs };
  };

  test("the Host list arrives in a batch", async () => {
    const { sent, subs } = open();

    subs.subscribe({ id: 1, kind: "hosts", input: {} });
    await until(() => sent.length > 0);
    subs.dispose();

    expect(sent[0]).toEqual({ id: 1, items: [[view]] });
  });

  test("the machines list arrives: this Mac, then the remote Hosts from settings", async () => {
    const { sent, subs } = open();

    subs.subscribe({ id: 1, kind: "machines", input: {} });
    await until(() => sent.length > 0);
    subs.dispose();

    // SAFETY: the machines feed's items are MachineView lists.
    const machines = sent[0]?.items[0] as ReadonlyArray<{ key: string; status: unknown }>;
    expect(machines.map((m) => m.key)).toEqual(["local", "studio"]);
    expect(machines[1]?.status).toBeNull();
  });

  test("an unknown kind or undecodable input ends the subscription with an error", async () => {
    const { sent, subs } = open();

    subs.subscribe({ id: 1, kind: "nope", input: {} });
    subs.subscribe({ id: 2, kind: "session", input: { hostKey: "local" } });
    await until(() => sent.some((e) => e.id === 1) && sent.some((e) => e.id === 2));
    subs.dispose();

    expect(sent.find((e) => e.id === 1)?.end?.code).toBe("UnknownSubscription");
    expect(sent.find((e) => e.id === 2)?.end?.code).toBe("InvalidInput");
  });
});
