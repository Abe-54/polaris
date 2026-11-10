/**
 * Runs Callstack's agent-device CLI (ADR 0099) with the Bun its install came with: its daemon
 * inherits the same runtime, so no Node is needed. It never checks for updates.
 */
import { delimiter, join } from "node:path";
import { Option, Schema } from "effect";
import type { BunRuntime } from "../../install/simulator/index.ts";
import { executableOf } from "../../platform/executable.ts";
import { childEnv } from "../../service/childEnv.ts";

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One agent-device command; killed after `timeoutMs`. */
export type AgentDeviceRun = (
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number }
) => Promise<RunResult>;

/** Its daemon exits on its own after 10 idle minutes; `daemon stop` ends it sooner. */
const DAEMON_IDLE_TIMEOUT_MS = "600000";

/**
 * agent-device finds adb on the PATH and the SDK by `ANDROID_HOME`: both point at the SDK
 * detection found, so a Daemon started without the user's shell profile still reaches it.
 */
export const androidEnv = (
  sdk: string | null,
  path: string | undefined
): Readonly<Record<string, string>> =>
  sdk === null
    ? {}
    : {
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: sdk,
        PATH: [join(sdk, "platform-tools"), join(sdk, "emulator"), path ?? ""]
          .filter((part) => part !== "")
          .join(delimiter),
      };

export const liveAgentDevice =
  (
    script: string,
    cwd: string,
    env: Readonly<Record<string, string>>,
    bun: BunRuntime
  ): AgentDeviceRun =>
  async (args, { timeoutMs }) => {
    const proc = Bun.spawn([executableOf(bun.program), script, ...args], {
      cwd,
      env: childEnv({
        ...process.env,
        ...env,
        ...bun.env,
        AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: DAEMON_IDLE_TIMEOUT_MS,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  };

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({ message: Schema.String, hint: Schema.optionalKey(Schema.String) })
  ),
});

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));

export type Outcome<A> =
  | { readonly ok: true; readonly data: A }
  | { readonly ok: false; readonly message: string };

const failureOf = (result: RunResult, error?: { message: string; hint?: string }): string => {
  if (error !== undefined)
    return error.hint === undefined ? error.message : `${error.message} ${error.hint}`;
  const said = `${result.stdout}\n${result.stderr}`.trim();

  return said === "" ? `agent-device exited with code ${result.exitCode}` : said;
};

/** A `--json` command's `data`, decoded with `schema`, or its error in its own words. */
export const jsonOutcome = <S extends Schema.Decoder<unknown>>(
  result: RunResult,
  schema: S
): Outcome<S["Type"]> => {
  const envelope = decodeEnvelope(result.stdout.trim());

  if (Option.isNone(envelope)) return { ok: false, message: failureOf(result) };

  if (!envelope.value.success)
    return { ok: false, message: failureOf(result, envelope.value.error) };
  const data = Schema.decodeUnknownOption(schema)(envelope.value.data);

  return Option.isSome(data)
    ? { ok: true, data: data.value }
    : { ok: false, message: "agent-device answered in a shape Polaris doesn't know" };
};

/** A plain command's output: what it printed, or its error. */
export const textOutcome = (result: RunResult): Outcome<string> =>
  result.exitCode === 0
    ? { ok: true, data: result.stdout.trim() }
    : { ok: false, message: failureOf(result) };
