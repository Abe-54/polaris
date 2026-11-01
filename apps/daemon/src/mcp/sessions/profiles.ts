import { ProfileError } from "@polaris/protocol";
import { Effect } from "effect";
import type { TraceSessions, TraceStore } from "../../traces/index.ts";
import type { Profiles } from "../../traces/profiles/index.ts";
import type { ProfileSessionTools } from "../tools/profile.ts";

export const sessionProfileTools = (
  profiles: Profiles["Service"],
  sessions: TraceSessions["Service"],
  traces: TraceStore["Service"]
): ProfileSessionTools => ({
  capture: profiles.capture,
  attach: profiles.attach,
  restart: profiles.restart,
  get: profiles.get,
  overlapping: (id, profile) =>
    Effect.gen(function* () {
      const ctx = yield* sessions.session(id);
      const start = BigInt(Date.parse(profile.startedAt)) * 1_000_000n;
      const end = start + BigInt(Math.ceil(profile.durationMs * 1_000_000));

      return yield* traces.overlapping(ctx.checkout, start.toString(), end.toString());
    }).pipe(
      Effect.mapError(
        () =>
          new ProfileError({
            code: "E-PROFILE-UNAVAILABLE",
            message: "Overlapping traces couldn't be read.",
            fix: "Retry the profile read after checking the trace store.",
          })
      )
    ),
});
