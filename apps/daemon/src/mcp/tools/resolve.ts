import {
  AttemptId,
  ConstellationRejected,
  HarnessSelection,
  HostId,
  ModelId,
  SessionId,
  WorkerPlacement,
} from "@polaris/protocol";
import { Effect } from "effect";
import type { McpBinding } from "../binding.ts";
import { sessionBinding } from "../binding.ts";
import { FriendlyWorker } from "./inputs.ts";
import { rejection, graphSlice, type ConstellationCommands } from "./shared.ts";

interface HarnessSelectionFields {
  harness?: NonNullable<HarnessSelection["harness"]>;
  model?: NonNullable<HarnessSelection["model"]>;
  effort?: NonNullable<HarnessSelection["effort"]>;
  serviceTier?: Exclude<HarnessSelection["serviceTier"], undefined>;
}

export const resolvers = (binding: McpBinding, commands: ConstellationCommands) => {
  const caller = sessionBinding(binding);

  const resolve = (kind: "attempt" | "session" | "host" | "model", name: string) =>
    commands.resolve(caller, binding.constellationId, kind, name);

  const selection = Effect.fnUntraced(function* (input: HarnessSelection | null) {
    if (input === null) return null;

    const model =
      input.model === undefined ? undefined : ModelId.make(yield* resolve("model", input.model));

    const fields: HarnessSelectionFields = {};

    if (input.harness !== undefined) fields.harness = input.harness;

    if (model !== undefined) fields.model = model;

    if (input.effort !== undefined) fields.effort = input.effort;

    if (input.serviceTier !== undefined) fields.serviceTier = input.serviceTier;

    return new HarnessSelection(fields);
  });

  const worker = Effect.fnUntraced(function* (input: typeof FriendlyWorker.Type) {
    if ("session" in input)
      return WorkerPlacement.cases.Existing.make({
        sessionId: SessionId.make(yield* resolve("session", input.session)),
      });

    return WorkerPlacement.cases.New.make({
      hostId: HostId.make(yield* resolve("host", input.host)),
      selection: yield* selection(input.selection),
      base: input.base,
      worktree: input.worktree,
      branch: input.branch,
    });
  });

  const attempt = (name: string) =>
    resolve("attempt", name).pipe(
      Effect.map((id) => AttemptId.make(id)),
      Effect.catchTag("ConstellationRejected", (error) => {
        if (!error.findings.every((finding) => finding.code === "E-REFERENCE"))
          return Effect.fail(error);

        return Effect.gen(function* () {
          const sessionId = yield* resolve("session", name);
          const current = yield* commands.status(caller, binding.constellationId, true);

          const matches =
            current.constellation?.attempts.filter((item) => item.sessionId === sessionId) ?? [];

          const active = matches.filter(
            (item) => item.state === "working" || item.state === "review"
          );

          const chosen = active.length === 1 ? active[0] : matches.at(-1);

          if (chosen === undefined || active.length > 1)
            return yield* new ConstellationRejected({
              findings: rejection(
                "E-REFERENCE",
                `No unique worker named ${name}`,
                "Use a short Task id or an unambiguous worker session name."
              ).findings,
              graph: graphSlice(current),
              revision: current.revision,
            });

          return chosen.id;
        }).pipe(
          Effect.catchTag("ConstellationRejected", (fallback) =>
            Effect.fail(
              fallback.findings.every((finding) => finding.code === "E-REFERENCE")
                ? error
                : fallback
            )
          )
        );
      })
    );

  return { attempt, selection, worker };
};
