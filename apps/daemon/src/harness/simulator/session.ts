/**
 * One Agent Session's Simulator tools: each call runs agent-device bound to the session's own
 * agent-device session and Simulator, one at a time, with `AgentDriving` held while it runs.
 * A call slower than `softWaitMs` carries on in the background and says so.
 */
import type { SessionId } from "@polaris/protocol";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit, Match, Schema, Scope } from "effect";
import type { SimulatorActivity } from "./activity.ts";
import { type AgentDeviceRun, jsonOutcome, type Outcome, textOutcome } from "./agentDevice.ts";
import {
  describeDevice,
  DeviceList,
  LABEL,
  NONE_LISTED,
  OPEN_SLOW,
  type Platform,
  platformOf,
  selectorOf,
} from "./platforms.ts";

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface ToolResult {
  readonly content: Array<ToolContent>;
  readonly isError?: boolean;
}

export interface SessionDeps {
  readonly sessionId: SessionId;
  /** Why `platform`'s Simulators can't run now, or null. */
  readonly blocker: (platform: Platform) => Promise<string | null>;
  /** The platforms this Host could run, for a list. */
  readonly platforms: () => Promise<ReadonlyArray<Platform>>;
  /** agent-device, installed on first use; rejects with the install's own message. */
  readonly agentDevice: () => Promise<AgentDeviceRun>;
  readonly activity: SimulatorActivity;
  /** A private directory for screenshots on their way to the agent. */
  readonly scratch: string;
  readonly softWaitMs?: number | undefined;
}

export const text = (body: string): ToolResult => ({ content: [{ type: "text", text: body }] });

export const failure = (body: string): ToolResult => ({
  content: [{ type: "text", text: body }],
  isError: true,
});

/** A list's target: it names no device. */
const NO_TARGET: Target = { platform: "ios", id: "" };

const NO_SIMULATOR =
  "No Simulator is open in this session yet: call simulator_list, then simulator_open with an id.";

const stillRunning = (label: string, note: string) =>
  text(
    `${label} is still running and carries on in the background. ${note} Call the same tool again to wait for it.`
  );

/** How long a call waits before answering that it carries on in the background. */
const SOFT_WAIT_MS = 45_000;

/** agent-device's own request timeout for an open, which may boot and build the runner. */
const OPEN_TIMEOUT_MS = 300_000;

const SNAPSHOT_TIMEOUT_MS = 120_000;

/** The process is killed this long after agent-device's own timeout would have fired. */
const KILL_MARGIN_MS = 30_000;

const OpenData = Schema.Struct({
  device: Schema.optionalKey(Schema.String),
  selection: Schema.optionalKey(
    Schema.Struct({ bootOccurred: Schema.optionalKey(Schema.Boolean) })
  ),
});

export type PressKey = "home" | "back" | "return" | "dismiss_keyboard";

const PRESS_ARGS: Record<PressKey, ReadonlyArray<string>> = {
  home: ["home"],
  back: ["back", "--settle"],
  return: ["keyboard", "return"],
  dismiss_keyboard: ["keyboard", "dismiss"],
};

const sessionName = (sessionId: SessionId) =>
  `polaris-${sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;

interface Pending {
  readonly tool: string;
  readonly label: string;
  readonly note: string;
  readonly done: Promise<ToolResult>;
}

const settledWithin = async <A>(promise: Promise<A>, ms: number): Promise<A | "pending"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const late = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });

  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};

const unwrap = <A>(outcome: Outcome<A>, onOk: (data: A) => ToolResult): ToolResult =>
  outcome.ok ? onOk(outcome.data) : failure(outcome.message);

/** One device: an iOS Simulator by UDID, or an Android Emulator by serial or AVD name. */
export interface Target {
  readonly platform: Platform;
  readonly id: string;
}

export interface Step {
  /** The tool's name: a pending call is joined by the same tool, not run again. */
  readonly tool: string;
  /** "Opening the Simulator", for a call that outlasts the wait. */
  readonly label: string;
  readonly note?: string;
  /** An open names its Simulator; a list needs none; the rest act on the session's. */
  readonly target: "chosen" | "current" | "none";
  readonly work: (
    run: AgentDeviceRun,
    target: Target & {
      /** `command`, the session's binding, then `values` after `--`, so none reads as a flag. */
      readonly argv: (
        command: ReadonlyArray<string>,
        values: ReadonlyArray<string>
      ) => ReadonlyArray<string>;
    }
  ) => Promise<ToolResult>;
}

export const simulatorSession = (deps: SessionDeps) => {
  const { sessionId, activity } = deps;
  const softWaitMs = deps.softWaitMs ?? SOFT_WAIT_MS;
  const name = sessionName(sessionId);
  let current: Target | null = null;
  let pending: Pending | null = null;
  let used = false;

  const argvOf =
    (target: Target) => (command: ReadonlyArray<string>, values: ReadonlyArray<string>) => [
      ...command,
      ...selectorOf(target.platform, target.id),
      "--session",
      name,
      "--",
      ...values,
    ];

  const shown = async (): Promise<Target | null> => {
    const id = await Effect.runPromise(activity.shown(sessionId));

    return id === null ? null : { platform: platformOf(id), id };
  };

  const holdDriving = async () => {
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(Scope.provide(activity.agentDriving(sessionId), scope));

    return () => Effect.runPromise(Scope.close(scope, Exit.void));
  };

  const targetOf = async (step: Step, chosen: Target | undefined): Promise<Target | null> =>
    Match.value(step.target).pipe(
      Match.when("none", () => Promise.resolve(NO_TARGET)),
      Match.when("chosen", () => Promise.resolve(chosen ?? null)),
      Match.when("current", async () => current ?? (await shown())),
      Match.exhaustive
    );

  const execute = async (step: Step, target: Target): Promise<ToolResult> => {
    let run: AgentDeviceRun;

    try {
      run = await deps.agentDevice();
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    used = true;
    const release = step.target === "none" ? async () => {} : await holdDriving();

    try {
      return await step.work(run, { ...target, argv: argvOf(target) });
    } catch (error) {
      return failure(`agent-device didn't run: ${String(error)}`);
    } finally {
      await release();
    }
  };

  /** Waits for a call still running from before; its result answers the same tool. */
  const joinPending = async (step: Step): Promise<ToolResult | null> => {
    if (pending === null) return null;
    const earlier = pending;
    const settled = await settledWithin(earlier.done, softWaitMs);

    if (settled === "pending") return stillRunning(earlier.label, earlier.note);
    pending = null;

    return earlier.tool === step.tool ? settled : null;
  };

  const call = async (step: Step, chosen?: Target): Promise<ToolResult> => {
    const joined = await joinPending(step);

    if (joined !== null) return joined;
    const target = await targetOf(step, chosen);

    if (target === null) return failure(NO_SIMULATOR);
    const blocked = step.target === "none" ? null : await deps.blocker(target.platform);

    if (blocked !== null) return failure(blocked);
    const done = execute(step, target);
    const settled = await settledWithin(done, softWaitMs);

    if (settled !== "pending") return settled;
    const note = step.note ?? "";
    pending = { tool: step.tool, label: step.label, note, done };

    return stillRunning(step.label, note);
  };

  const opened = async (target: Target, bootOccurred: boolean) => {
    if (bootOccurred) await Effect.runPromise(activity.agentBooted(target.id));
    await Effect.runPromise(activity.agentOpened(sessionId, target.id));
    current = { platform: target.platform, id: target.id };
  };

  const open = (id: string, app: string | undefined, platform = platformOf(id)) =>
    call(
      {
        tool: "simulator_open",
        label: "Opening the Simulator",
        note: OPEN_SLOW[platform],
        target: "chosen",
        work: async (run, target) => {
          const result = await run(
            target.argv(
              [
                "open",
                ...(app === undefined ? [] : ["--foreground"]),
                "--json",
                "--timeout",
                String(OPEN_TIMEOUT_MS),
              ],
              app === undefined ? [] : [app]
            ),
            { timeoutMs: OPEN_TIMEOUT_MS + KILL_MARGIN_MS }
          );

          const outcome = jsonOutcome(result, OpenData);

          if (!outcome.ok) return failure(outcome.message);
          await opened(target, outcome.data.selection?.bootOccurred === true);

          return text(
            `Opened ${outcome.data.device ?? target.id}${app === undefined ? "" : ` with ${app}`}; the user sees it in the session's Simulator tab. Call simulator_snapshot for its accessibility tree.`
          );
        },
      },
      { platform, id }
    );

  /** A plain command on the session's Simulator, answered with what agent-device printed. */
  const plain = (
    tool: string,
    label: string,
    command: ReadonlyArray<string>,
    values: ReadonlyArray<string> = [],
    timeoutMs = 90_000,
    after?: () => void
  ) =>
    call({
      tool,
      label,
      target: "current",
      work: async (run, target) => {
        const outcome = textOutcome(await run(target.argv(command, values), { timeoutMs }));
        after?.();

        return unwrap(outcome, (out) => text(out === "" ? "Done." : out));
      },
    });

  const screenshot = () =>
    call({
      tool: "simulator_screenshot",
      label: "The screenshot",
      target: "current",
      work: async (run, target) => {
        const path = join(deps.scratch, `${randomUUID()}.png`);

        try {
          const outcome = jsonOutcome(
            await run(target.argv(["screenshot", "--json"], [path]), { timeoutMs: 90_000 }),
            Schema.Unknown
          );

          if (!outcome.ok) return failure(outcome.message);
          const data = (await readFile(path)).toString("base64");

          return { content: [{ type: "image", data, mimeType: "image/png" }] };
        } finally {
          await rm(path, { force: true });
        }
      },
    });

  /** Each platform's devices, or why it can't run them yet. */
  const listOne = async (run: AgentDeviceRun, platform: Platform): Promise<string> => {
    const blocked = await deps.blocker(platform);

    if (blocked !== null) return `${LABEL[platform]}: ${blocked}`;

    const outcome = jsonOutcome(
      await run(["devices", "--platform", platform, "--json"], { timeoutMs: 60_000 }),
      DeviceList
    );

    if (!outcome.ok) return `${LABEL[platform]}: ${outcome.message}`;
    const { devices } = outcome.data;

    return devices.length === 0
      ? NONE_LISTED[platform]
      : devices.map((device) => describeDevice(platform, device)).join("\n");
  };

  const list = () =>
    call({
      tool: "simulator_list",
      label: "Listing the Simulators",
      target: "none",
      work: async (run) => {
        const platforms = await deps.platforms();
        const sections = await Promise.all(platforms.map((platform) => listOne(run, platform)));

        return text(sections.join("\n\n"));
      },
    });

  return {
    sessionId,
    sessionName: name,
    list,
    /** Whether any command ran, so the Daemon knows agent-device's daemon may be up. */
    used: () => used,
    open,
    snapshot: () =>
      plain(
        "simulator_snapshot",
        "The snapshot",
        ["snapshot", "-i", "--timeout", String(SNAPSHOT_TIMEOUT_MS)],
        [],
        SNAPSHOT_TIMEOUT_MS + KILL_MARGIN_MS
      ),
    tap: (target: ReadonlyArray<string>) =>
      plain("simulator_tap", "The tap", ["press", "--settle"], target),
    type: (value: string, into: string | undefined) =>
      plain(
        "simulator_type",
        "Typing",
        into === undefined ? ["type"] : ["fill", "--settle"],
        into === undefined ? [value] : [into, value]
      ),
    swipe: (from: readonly [number, number], to: readonly [number, number]) =>
      plain("simulator_swipe", "The swipe", ["swipe"], [...from, ...to].map(String)),
    scroll: (direction: string, amount: number | undefined) =>
      plain(
        "simulator_scroll",
        "The scroll",
        ["scroll", "--settle"],
        [direction, ...(amount === undefined ? [] : [String(amount)])]
      ),
    press: (key: PressKey) => plain("simulator_press", "The key press", PRESS_ARGS[key]),
    screenshot,
    launch: (app: string) =>
      plain("simulator_launch", "Launching the app", ["open", "--foreground"], [app]),
    openUrl: (url: string) => plain("simulator_openurl", "Opening the URL", ["open"], [url]),
    close: () =>
      plain("simulator_close", "Closing", ["close"], [], 90_000, () => {
        current = null;
      }),
  };
};

export type SimulatorSession = ReturnType<typeof simulatorSession>;
