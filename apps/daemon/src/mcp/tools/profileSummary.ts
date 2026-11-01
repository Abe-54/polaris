import type { Profile, ProfileDetail, TraceSummary } from "@polaris/protocol";
import { inline, TRACE_CAP } from "./traceFormat.ts";

const label = (value: string) => inline(value).slice(0, 256).toWellFormed();

const bytes = <A>(value: A) => Buffer.byteLength(JSON.stringify(value));

export const profileMetadata = (profile: Profile) => ({
  ...profile,
  id: label(profile.id),
  command: label(profile.command),
  ...(profile.cwd === undefined ? undefined : { cwd: label(profile.cwd) }),
  ...(profile.service === undefined ? undefined : { service: label(profile.service) }),
  path: profile.path === null ? null : label(profile.path),
  turn:
    profile.turn === null
      ? null
      : {
          ...profile.turn,
          id: label(profile.turn.id),
          sessionId: label(profile.turn.sessionId),
        },
});

const bounded = <A>(values: Iterable<A>, budget: number): A[] => {
  const result: A[] = [];
  let size = 2;

  for (const value of values) {
    const added = bytes(value) + 1;

    if (size + added > budget) break;
    result.push(value);
    size += added;
  }

  return result;
};

/** Detail and its stable table indices remain available through the separate profiles.get RPC. */
export const profileSummary = (
  detail: ProfileDetail,
  overlap: { traces: ReadonlyArray<TraceSummary>; total: number }
) => {
  const summary = {
    profile: profileMetadata(detail.profile),
    functionCount: detail.hotFunctions.length,
    nodeCount: detail.nodes.length,
    hotPathCount: detail.hotPath.length,
    traceCount: overlap.total,
    detail: "Read the full recording with profiles.get or open it in Traces (⌘5).",
  };

  const budget = Math.floor((TRACE_CAP - bytes(summary) - 256) / 4);

  const frame = (index: number) => {
    const f = detail.hotFunctions[index]!;

    return {
      index,
      name: label(f.name),
      file: f.file === null ? null : label(f.file),
      line: f.line,
      selfMs: f.selfMs,
      totalMs: f.totalMs,
    };
  };

  const ranking = (mode: "selfMs" | "totalMs") => {
    const indices = detail.hotFunctions
      .map((_, index) => index)
      .sort((a, b) => detail.hotFunctions[b]![mode] - detail.hotFunctions[a]![mode] || a - b);

    return bounded(
      (function* () {
        for (const index of indices) yield frame(index);
      })(),
      budget
    );
  };

  return {
    ...summary,
    hotFunctions: ranking("selfMs"),
    totalFunctions: ranking("totalMs"),
    hotPath: bounded(detail.hotPath.map(frame), budget),
    traces: bounded(
      overlap.traces.map((t) => ({
        id: t.id,
        root: label(t.root),
        service: label(t.service),
        durationMs: t.durationMs,
      })),
      budget
    ),
  };
};
