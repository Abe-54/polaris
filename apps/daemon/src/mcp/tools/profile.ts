import {
  ProfileId,
  type Profile,
  type ProfileDetail,
  ProfileError,
  type SessionId,
  type TraceSummary,
} from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import type { SessionTools } from "../sessions/index.ts";
import type { Profiles } from "../../traces/profiles/index.ts";
import { jsonSchema, type BoundTool, type McpToolResult } from "./shared.ts";
import { duration, inline, TRACE_CAP } from "./traceFormat.ts";

export interface ProfileSessionTools extends Pick<
  Profiles["Service"],
  "capture" | "restart" | "get"
> {
  readonly attach?: Profiles["Service"]["attach"];
  readonly overlapping: (
    session: SessionId,
    profile: Profile
  ) => Effect.Effect<{ traces: ReadonlyArray<TraceSummary>; total: number }, ProfileError>;
}

export const ProfileInput = Schema.Struct({
  command: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(128)
    )
  ),
  attach: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  seconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
  process: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  id: Schema.optionalKey(ProfileId),
  waitSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 }))),
});

const failure = (code: string, message: string, fix: string): McpToolResult => ({
  isError: true,
  content: [{ type: "text", text: `${code}: ${message}\nFix: ${fix}`.slice(0, TRACE_CAP) }],
  structuredContent: { code, message, fix },
});

/** In-project frames lead each ranking; the protocol function table and indices are unchanged. */
const boundedSection = <A>(
  title: string,
  values: ReadonlyArray<A>,
  render: (value: A, index: number) => string,
  budget: number
) => {
  const lines = [title];
  let count = 0;
  let length = title.length;

  const note = (omitted: number) =>
    `\n… ${omitted} lines omitted; use profile id structuredContent.`;

  for (const value of values) {
    const line = render(value, count);

    if (length + line.length + 1 + note(values.length - count).length > budget) break;
    lines.push(line);
    length += line.length + 1;
    count++;
  }

  return lines.join("\n") + (count < values.length ? note(values.length - count) : "");
};

export const profileView = (
  detail: ProfileDetail,
  overlap: { traces: ReadonlyArray<TraceSummary>; total: number }
): string => {
  const { profile, hotFunctions, hotPath } = detail;
  const header = `${profile.status} · ${profile.runtime} · ${duration(profile.durationMs)} · profile ${profile.id}${profile.cwd === undefined ? "" : `\nDirectory: ${inline(profile.cwd)}`}\nArtifact: ${inline(profile.path ?? "none")}\nLabels over 256 characters are clipped; use profile id structuredContent for full details.`;

  const location = (f: ProfileDetail["hotFunctions"][number]) =>
    `${inline(f.name).slice(0, 256)}${f.file === null ? "" : `  ${inline(f.file).slice(0, 256)}${f.line === null ? "" : `:${f.line}`}`}`;

  const inProject = (f: ProfileDetail["hotFunctions"][number]) =>
    f.file !== null &&
    !/^(?:\/|[A-Za-z]:|node:|bun:|https?:|\.\.)/.test(f.file) &&
    !/(?:^|\/)node_modules\//.test(f.file);

  const budget = Math.floor((TRACE_CAP - header.length - 4) / 4);
  const sections = [header];

  for (const mode of ["selfMs", "totalMs"] as const) {
    const ranked = [...hotFunctions].sort(
      (a, b) => Number(inProject(b)) - Number(inProject(a)) || b[mode] - a[mode]
    );

    sections.push(
      boundedSection(
        mode === "selfMs" ? "Hot functions · self time" : "Hot functions · total time",
        ranked,
        (f) => `${duration(f.selfMs)} self  ${duration(f.totalMs)} total  ${location(f)}`,
        budget
      )
    );
  }

  sections.push(
    boundedSection(
      "Hot path",
      hotPath,
      (i, depth) => `${"  ".repeat(Math.min(depth, 20))}${location(hotFunctions[i]!)}`,
      budget
    )
  );
  sections.push(
    boundedSection(
      `Overlapping traces · ${overlap.traces.length} retained of ${overlap.total} (at most 200)`,
      overlap.traces,
      (t) =>
        `${t.id.slice(0, 8)}  ${inline(t.root).slice(0, 256)}  ${inline(t.service).slice(0, 256)}  ${duration(t.durationMs)}`,
      budget
    )
  );

  return sections.join("\n").slice(0, TRACE_CAP);
};

const validSelector = (value: typeof ProfileInput.Type) =>
  [value.command, value.process, value.attach, value.id].filter((v) => v !== undefined).length ===
    1 &&
  (value.waitSeconds === undefined || value.command !== undefined) &&
  (value.seconds === undefined || value.attach !== undefined);

const recordingFor = Effect.fnUntraced(function* (
  profiles: ProfileSessionTools,
  sessionId: SessionId,
  value: typeof ProfileInput.Type
): Effect.fn.Return<{ profile: Profile; retained?: ProfileDetail }, ProfileError> {
  if (value.id !== undefined) {
    const retained = yield* profiles.get(sessionId, value.id);

    return { profile: retained.profile, retained };
  }

  if (value.attach !== undefined) {
    if (!profiles.attach)
      return yield* new ProfileError({
        code: "E-PROFILE-UNAVAILABLE",
        message: "Inspector profiling is unavailable.",
        fix: "Use Restart with profiling instead.",
      });

    return { profile: yield* profiles.attach(sessionId, value.attach, value.seconds) };
  }

  if (value.process !== undefined)
    return { profile: yield* profiles.restart(sessionId, value.process) };

  return { profile: yield* profiles.capture(sessionId, value.command!, value.waitSeconds) };
});

export const profileTool = (sessionId: SessionId, sessions: SessionTools): BoundTool => ({
  name: "profile",
  description:
    "Profile a Node or Bun command (argv array), restart a process Polaris's Profiles service launched, or read a recording by id. Ask the user before restarting a process they started. Commands run in this checkout; waitSeconds defaults to 30 and does not stop long-running commands. Artifacts finalize on process exit. attach profiles a cooperatively registered Node pid for seconds (default 5, maximum 30), only after the user approves a Pending Approval. Capture uses a private in-process profiler without opening a network port. Unregistered processes are refused.",
  inputSchema: jsonSchema(ProfileInput),
  annotations: { readOnlyHint: false },
  call: (input, signal) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownOption(ProfileInput)(input, {
          onExcessProperty: "error",
        });

        if (Option.isNone(decoded))
          return failure(
            "E-INPUT",
            "Invalid input for profile.",
            "Use exactly one of command, process, attach or id."
          );
        const value = decoded.value;

        if (!validSelector(value))
          return failure(
            "E-INPUT",
            "Invalid profile selector.",
            "Use exactly one of command, process, attach or id; waitSeconds applies only to command and seconds only to attach."
          );

        if (sessions.profiles === undefined)
          return failure(
            "E-PROFILE-UNAVAILABLE",
            "Profiles isn't connected on this host.",
            "Check Traces (⌘5) on the host and retry."
          );
        const profiles = sessions.profiles;
        const { profile, retained } = yield* recordingFor(profiles, sessionId, value);

        if (profile.status !== "completed")
          return {
            content: [
              {
                type: "text",
                text: `${profile.status} · ${profile.runtime} · profile ${profile.id}${profile.cwd === undefined ? "" : `\nDirectory: ${inline(profile.cwd)}`}\n${profile.status === "recording" ? "The artifact finalizes on process exit. Read it with profile id." : "No valid artifact was produced. Run a shorter Node or Bun command and retry."}`,
              },
            ],
            structuredContent: { profile },
          } satisfies McpToolResult;
        const detail = retained ?? (yield* profiles.get(sessionId, profile.id));
        const overlap = yield* profiles.overlapping(sessionId, profile);

        return {
          content: [{ type: "text", text: profileView(detail, overlap) }],
          structuredContent: { ...detail, traces: overlap.traces, traceCount: overlap.total },
        } satisfies McpToolResult;
      }).pipe(
        Effect.catchTag("ProfileError", (e) => Effect.succeed(failure(e.code, e.message, e.fix)))
      ),
      { signal }
    ),
});
