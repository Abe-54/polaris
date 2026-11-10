/**
 * Run as a program by `caller.slow.test.ts`, under whichever executable plays the caller:
 * asks the helper at argv[2], through argv[3], to create the file argv[4], and prints what
 * came of it as JSON.
 */
import { Effect } from "effect";
import { ComputerUseHelper, type SpawnVia } from "./index.ts";
import { execHelper } from "./launch.ts";

const [helper, via, marker] = process.argv.slice(2);

const outcome = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const cu = yield* ComputerUseHelper;

      const running = yield* cu.spawn({
        tool: "agent-desktop",
        args: ["mark", marker ?? ""],
        // SAFETY: the test passes one of the two SpawnVia values.
        via: via as SpawnVia,
      });

      running.end();

      return yield* Effect.promise(async () => ({
        stdout: await new Response(running.stdout).text(),
        code: await running.exited,
      }));
    })
  ).pipe(
    Effect.catch((error) => Effect.succeed({ refused: error.message })),
    Effect.provide(ComputerUseHelper.layerAt(() => helper ?? null, { launch: execHelper }))
  )
);

console.log(JSON.stringify(outcome));
