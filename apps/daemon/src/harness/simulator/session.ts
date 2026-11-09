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

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface ToolResult {
  readonly content: Array<ToolContent>;
  readonly isError?: boolean;
}

export interface SessionDeps {
  readonly sessionId: SessionId;
  /** Why iOS Simulators can't run now, or null. */
  readonly blocker: () => Promise<string | null>;
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

const NO_SIMULATOR =
  "No Simulator is open in this session yet: call simulator_list, then simulator_open with an id.";

/** The first open builds agent-device's iOS runner for this Xcode (47 s in the spike). */
export const OPEN_SLOW =
  "The first open on this Host builds agent-device's iOS runner for this Xcode, which takes about a minute (more on a busy Mac).";

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

export const DeviceList = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      platform: Schema.String,
      kind: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
      osVersion: Schema.optionalKey(Schema.String),
      booted: Schema.optionalKey(Schema.Boolean),
    })
  ),
});

const describeDevice = (device: (typeof DeviceList.Type)["devices"][number]) =>
  [
    device.id,
    device.name,
    device.osVersion === undefined ? null : `iOS ${device.osVersion}`,
    device.model,
    device.booted === true ? "booted" : "shut down",
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" · ");

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
    target: { readonly id: string; readonly flags: ReadonlyArray<string> }
  ) => Promise<ToolResult>;
}

export const simulatorSession = (deps: SessionDeps) => {
  const { sessionId, activity } = deps;
  const softWaitMs = deps.softWaitMs ?? SOFT_WAIT_MS;
  const name = sessionName(sessionId);
  let current: string | null = null;
  let pending: Pending | null = null;
  let used = false;

  const flagsOf = (id: string) => ["--platform", "ios", "--udid", id, "--session", name];

  const holdDriving = async () => {
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(Scope.provide(activity.agentDriving(sessionId), scope));

    return () => Effect.runPromise(Scope.close(scope, Exit.void));
  };

  const targetOf = async (step: Step, chosen: string | undefined) =>
    Match.value(step.target).pipe(
      Match.when("none", () => Promise.resolve("")),
      Match.when("chosen", () => Promise.resolve(chosen ?? null)),
      Match.when(
        "current",
        async () => current ?? (await Effect.runPromise(activity.shown(sessionId)))
      ),
      Match.exhaustive
    );

  const execute = async (step: Step, id: string): Promise<ToolResult> => {
    let run: AgentDeviceRun;

    try {
      run = await deps.agentDevice();
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    used = true;
    const release = step.target === "none" ? async () => {} : await holdDriving();

    try {
      return await step.work(run, { id, flags: flagsOf(id) });
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

  const call = async (step: Step, chosen?: string): Promise<ToolResult> => {
    const joined = await joinPending(step);

    if (joined !== null) return joined;
    const blocked = await deps.blocker();

    if (blocked !== null) return failure(blocked);
    const id = await targetOf(step, chosen);

    if (id === null) return failure(NO_SIMULATOR);
    const done = execute(step, id);
    const settled = await settledWithin(done, softWaitMs);

    if (settled !== "pending") return settled;
    const note = step.note ?? "";
    pending = { tool: step.tool, label: step.label, note, done };

    return stillRunning(step.label, note);
  };

  const opened = async (id: string, bootOccurred: boolean) => {
    if (bootOccurred) await Effect.runPromise(activity.agentBooted(id));
    await Effect.runPromise(activity.agentOpened(sessionId, id));
    current = id;
  };

  const open = (id: string | undefined, app: string | undefined) =>
    call(
      {
        tool: "simulator_open",
        label: "Opening the Simulator",
        note: OPEN_SLOW,
        target: "chosen",
        work: async (run, target) => {
          const result = await run(
            [
              "open",
              ...(app === undefined ? [] : [app, "--foreground"]),
              "--json",
              "--timeout",
              String(OPEN_TIMEOUT_MS),
              ...target.flags,
            ],
            { timeoutMs: OPEN_TIMEOUT_MS + KILL_MARGIN_MS }
          );

          const outcome = jsonOutcome(result, OpenData);

          if (!outcome.ok) return failure(outcome.message);
          await opened(target.id, outcome.data.selection?.bootOccurred === true);

          return text(
            `Opened ${outcome.data.device ?? target.id}${app === undefined ? "" : ` with ${app}`}; the user sees it in the session's Simulator tab. Call simulator_snapshot for its accessibility tree.`
          );
        },
      },
      id
    );

  /** A plain command on the session's Simulator, answered with what agent-device printed. */
  const plain = (
    tool: string,
    label: string,
    args: ReadonlyArray<string>,
    timeoutMs = 90_000,
    after?: () => void
  ) =>
    call({
      tool,
      label,
      target: "current",
      work: async (run, target) => {
        const outcome = textOutcome(await run([...args, ...target.flags], { timeoutMs }));
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
            await run(["screenshot", path, "--json", ...target.flags], { timeoutMs: 90_000 }),
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

  const list = () =>
    call({
      tool: "simulator_list",
      label: "Listing the Simulators",
      target: "none",
      work: async (run) => {
        const outcome = jsonOutcome(
          await run(["devices", "--platform", "ios", "--json"], { timeoutMs: 60_000 }),
          DeviceList
        );

        return unwrap(outcome, ({ devices }) =>
          text(
            devices.length === 0
              ? "No iOS Simulators on this Host: create one in Xcode (Window > Devices and Simulators)."
              : devices.map(describeDevice).join("\n")
          )
        );
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
        SNAPSHOT_TIMEOUT_MS + KILL_MARGIN_MS
      ),
    tap: (target: ReadonlyArray<string>) =>
      plain("simulator_tap", "The tap", ["press", ...target, "--settle"]),
    type: (value: string, into: string | undefined) =>
      plain(
        "simulator_type",
        "Typing",
        into === undefined ? ["type", value] : ["fill", into, value, "--settle"]
      ),
    swipe: (from: readonly [number, number], to: readonly [number, number]) =>
      plain("simulator_swipe", "The swipe", ["swipe", ...[...from, ...to].map(String)]),
    scroll: (direction: string, amount: number | undefined) =>
      plain("simulator_scroll", "The scroll", [
        "scroll",
        direction,
        ...(amount === undefined ? [] : [String(amount)]),
        "--settle",
      ]),
    press: (key: PressKey) => plain("simulator_press", "The key press", PRESS_ARGS[key]),
    screenshot,
    launch: (app: string) =>
      plain("simulator_launch", "Launching the app", ["open", app, "--foreground"]),
    openUrl: (url: string) => plain("simulator_openurl", "Opening the URL", ["open", url]),
    close: () =>
      plain("simulator_close", "Closing", ["close"], 90_000, () => {
        current = null;
      }),
  };
};

export type SimulatorSession = ReturnType<typeof simulatorSession>;
