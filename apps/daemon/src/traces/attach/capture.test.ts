import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Profiles } from "../profiles/index.ts";
import { withProfiles } from "../profiles/testing.ts";
import { TEST_SESSION } from "../testing.ts";

// ENG-702: attach used to replace the registry's reason with a generic one.
test("attach to an unregistered process reports the registry's reason", () =>
  withProfiles(async ({ runtime }) => {
    const error = await runtime.runPromise(
      Effect.flip(
        Effect.flatMap(Profiles, (profiles) => profiles.attach(TEST_SESSION, process.pid))
      )
    );

    expect(error.message).toBe(
      "This Node process is not registered for this agent session. Restart with profiling instead."
    );
  }));
