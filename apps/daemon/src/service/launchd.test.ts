import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { type CommandResult, CommandRunner } from "./CommandRunner.ts";
import {
  activateLaunchd,
  classifyBootstrap,
  type LaunchdDomain,
  type LaunchdState,
  planLaunchd,
} from "./launchd.ts";

const LABEL = "dev.lux.polaris.test";

const target = { uid: 501, label: LABEL, serviceFile: "/tmp/agent.plist" };

const timing = { unloadTimeoutMs: 50, pollMs: 1 };

interface FakeLaunchd {
  guiDomain: boolean;
  /** The label's job per domain; `exitPolls` counts the prints it still answers after a bootout. */
  jobs: Map<LaunchdDomain, { exitPolls: number | null }>;
  /** Prints a booted-out job keeps answering before it is gone (a Daemon shutting down). */
  exitPolls: number;
  /** Scripted bootstrap answers, by attempt; null falls through to the model. */
  bootstrap: (domain: LaunchdDomain, attempt: number) => Partial<CommandResult> | null;
}

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

const fail = (code: number, stderr: string): CommandResult => ({ code, stdout: "", stderr });

/** A launchd for one label: enough of print, bootout, bootstrap, enable and kickstart. */
const fakeLaunchd = (initial: Partial<FakeLaunchd> = {}) => {
  const state: FakeLaunchd = {
    guiDomain: true,
    jobs: new Map(),
    exitPolls: 3,
    bootstrap: () => null,
    ...initial,
  };

  const calls: Array<string> = [];
  let bootstraps = 0;
  const domainOf = (id: string): LaunchdDomain => (id.startsWith("gui/") ? "gui" : "user");

  const print = (id: string): CommandResult => {
    const domain = domainOf(id);

    if (!id.endsWith(`/${LABEL}`))
      return domain === "user" || state.guiDomain ? ok : fail(112, "Could not find domain");
    const job = state.jobs.get(domain);

    if (job === undefined) return fail(113, "Could not find service");

    if (job.exitPolls !== null) {
      if (job.exitPolls === 0) {
        state.jobs.delete(domain);

        return fail(113, "Could not find service");
      }

      job.exitPolls--;
    }

    return ok;
  };

  const bootstrap = (domain: LaunchdDomain): CommandResult => {
    const scripted = state.bootstrap(domain, bootstraps++);

    if (scripted !== null) return { ...ok, ...scripted };

    if (domain === "gui" && !state.guiDomain)
      return fail(125, "Bootstrap failed: 125: Domain does not support specified action");

    if (state.jobs.size > 0) return fail(5, "Bootstrap failed: 5: Input/output error");
    state.jobs.set(domain, { exitPolls: null });

    return ok;
  };

  const respond = (argv: ReadonlyArray<string>): CommandResult => {
    const [, verb, a = "", b = ""] = argv;
    const id = verb === "kickstart" && a === "-k" ? b : a;

    if (verb === "print") return print(id);

    if (verb === "bootstrap") return bootstrap(domainOf(a));

    if (verb === "bootout") {
      const job = state.jobs.get(domainOf(id));

      if (job === undefined) return fail(3, "Boot-out failed: 3: No such process");
      job.exitPolls = state.exitPolls;

      return ok;
    }

    if (verb === "kickstart")
      return state.jobs.get(domainOf(id))?.exitPolls === null ? ok : fail(113, "not loaded");

    return ok;
  };

  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: (argv) =>
        Effect.sync(() => {
          calls.push(argv.join(" "));

          return respond(argv);
        }),
    })
  );

  return { state, calls, layer };
};

const loadedIn = (domain: LaunchdDomain) => new Map([[domain, { exitPolls: null }]]);

const activation = (
  launchd: ReturnType<typeof fakeLaunchd>,
  changed: LaunchdState["changed"],
  restored: { count: number }
) =>
  activateLaunchd(
    target,
    changed,
    Effect.sync(() => {
      restored.count++;

      return true;
    }),
    timing
  ).pipe(Effect.provide(launchd.layer));

const activate = (
  launchd: ReturnType<typeof fakeLaunchd>,
  changed: LaunchdState["changed"],
  restored = { count: 0 }
) => Effect.runPromise(activation(launchd, changed, restored));

/** The InstallError activation fails with. */
const activateFailing = (
  launchd: ReturnType<typeof fakeLaunchd>,
  changed: LaunchdState["changed"],
  restored = { count: 0 }
) => Effect.runPromise(Effect.flip(activation(launchd, changed, restored)));

const newPlist = { binary: true, serviceFile: true };

describe("planLaunchd", () => {
  const plan = (state: Partial<LaunchdState>) =>
    planLaunchd({
      loadedIn: null,
      guiDomain: true,
      changed: { binary: false, serviceFile: false },
      ...state,
    });

  test.each<[string, Parameters<typeof plan>[0], ReturnType<typeof plan>]>([
    ["loads into gui when it exists", {}, { action: "load", domain: "gui" }],
    ["loads into user without gui", { guiDomain: false }, { action: "load", domain: "user" }],
    [
      "reloads a changed definition in the gui domain it is loaded in",
      { loadedIn: "gui", changed: newPlist },
      { action: "reload", domain: "gui" },
    ],
    [
      "reloads a changed definition in the user domain it is loaded in, though gui exists",
      { loadedIn: "user", guiDomain: true, changed: newPlist },
      { action: "reload", domain: "user" },
    ],
    [
      "kickstarts an unchanged definition without a restart",
      { loadedIn: "gui" },
      { action: "kickstart", domain: "gui", restart: false },
    ],
    [
      "kickstarts with a restart for a new binary",
      { loadedIn: "user", changed: { binary: true, serviceFile: false } },
      { action: "kickstart", domain: "user", restart: true },
    ],
  ])("%s", (_name, state, expected) => {
    expect(plan(state)).toEqual(expected);
  });
});

describe("classifyBootstrap", () => {
  test("tells an occupied label from a missing domain", () => {
    expect(classifyBootstrap(ok)).toBe("loaded");
    expect(classifyBootstrap(fail(5, "Bootstrap failed: 5: Input/output error"))).toBe("busy");
    expect(classifyBootstrap(fail(112, "Could not find domain for user gui: 501"))).toBe(
      "no-domain"
    );
    expect(classifyBootstrap(fail(125, "Domain does not support specified action"))).toBe(
      "no-domain"
    );
    expect(classifyBootstrap(fail(1, "Could not find domain for port"))).toBe("no-domain");
    expect(classifyBootstrap(fail(1, "Operation not permitted"))).toBe("failed");
  });
});

describe("activateLaunchd", () => {
  test("a new definition over a loaded gui service waits for the old job, then loads in gui", async () => {
    // The incident: bootstrap right after bootout got 5 and fell back to user/.
    const launchd = fakeLaunchd({ jobs: loadedIn("gui") });
    const result = await activate(launchd, newPlist);

    expect(result.domain).toBe("gui/501");
    expect(result.restarted).toBe(true);

    expect(launchd.calls.filter((c) => c.includes("user/"))).toEqual([]);
    expect([...launchd.state.jobs.keys()]).toEqual(["gui"]);
    const bootout = launchd.calls.indexOf(`launchctl bootout gui/501/${LABEL}`);
    const bootstrap = launchd.calls.indexOf(`launchctl bootstrap gui/501 ${target.serviceFile}`);
    expect(bootout).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(bootout + launchd.state.exitPolls);
  });

  test("retries a bootstrap launchd still refuses as busy", async () => {
    const launchd = fakeLaunchd({
      jobs: loadedIn("gui"),
      bootstrap: (_, attempt) =>
        attempt === 0 ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : null,
    });

    const result = await activate(launchd, newPlist);

    expect(result.domain).toBe("gui/501");
    expect([...launchd.state.jobs.keys()]).toEqual(["gui"]);
  });

  test("reloads a service loaded in user/ there, even with a GUI session", async () => {
    const launchd = fakeLaunchd({ jobs: loadedIn("user") });
    const result = await activate(launchd, newPlist);

    expect(result.domain).toBe("user/501");
    expect(launchd.calls.some((c) => c.includes(" gui/501 "))).toBe(false);
  });

  test("an unchanged definition is only kickstarted", async () => {
    const launchd = fakeLaunchd({ jobs: loadedIn("gui") });
    await activate(launchd, { binary: true, serviceFile: false });

    expect(launchd.calls).toEqual([
      `launchctl print gui/501/${LABEL}`,
      `launchctl kickstart -k gui/501/${LABEL}`,
    ]);
  });

  test("without a GUI domain it loads into user/ and says so", async () => {
    const launchd = fakeLaunchd({ guiDomain: false });
    const result = await activate(launchd, newPlist);

    expect(result.domain).toBe("user/501");
    expect(result.notes.join("\n")).toContain("No GUI login session");
  });

  test("a GUI domain this session can't use falls back to user/", async () => {
    const launchd = fakeLaunchd({
      bootstrap: (domain) =>
        domain === "gui" ? { code: 125, stderr: "Domain does not support specified action" } : null,
    });

    const result = await activate(launchd, newPlist);

    expect(result.domain).toBe("user/501");
    expect([...launchd.state.jobs.keys()]).toEqual(["user"]);
  });

  test("a new definition that won't load rolls back to the previous one, running", async () => {
    const launchd = fakeLaunchd({
      jobs: loadedIn("gui"),
      bootstrap: (_, attempt) =>
        attempt === 0 ? { code: 1, stderr: "Bootstrap failed: 1: Operation not permitted" } : null,
    });

    const restored = { count: 0 };
    const failure = await activateFailing(launchd, newPlist, restored);

    expect(failure.step).toBe("load service");
    expect(failure.message).toContain("launchctl bootstrap gui/501 exited 1");
    expect(failure.message).toContain("the previous Daemon runs again in gui/501");

    expect(restored.count).toBe(1);
    expect(launchd.state.jobs.get("gui")).toEqual({ exitPolls: null });
    expect(launchd.calls.at(-1)).toBe(`launchctl kickstart gui/501/${LABEL}`);
  });

  test("a job that never exits fails without loading a second copy", async () => {
    const launchd = fakeLaunchd({ jobs: loadedIn("gui"), exitPolls: 1_000 });
    const failure = await activateFailing(launchd, newPlist);

    expect(failure.message).toContain("still loaded");
    expect(failure.message).toContain("rollback failed too");

    expect(launchd.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
  });

  test("a fresh install that fails restores the files and leaves nothing loaded", async () => {
    const launchd = fakeLaunchd({
      bootstrap: () => ({ code: 1, stderr: "Bootstrap failed: 1: Operation not permitted" }),
    });

    const restored = { count: 0 };
    const failure = await activateFailing(launchd, newPlist, restored);

    expect(failure.message).toContain("the Daemon was not loaded before");
    expect(restored.count).toBe(1);
  });
});
