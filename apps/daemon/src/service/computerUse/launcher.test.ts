/**
 * The helper's launcher (`launcher.c`), compiled here and driven through the Daemon's API with
 * a shell script standing in for agent-desktop. macOS only: it needs clang and the disclaim SPI.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { Effect } from "effect";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { compileLauncher } from "./build.ts";
import { COMPUTER_USE_BUNDLE, COMPUTER_USE_LAUNCHER, HELPER_FILES, launcherOf } from "./bundle.ts";
import { ComputerUseHelper, type HelperRequest, type SpawnVia } from "./index.ts";
import { execHelper } from "./launchServices.ts";

const TOOL = `#!/bin/sh
case "$1" in
  echo) cat ;;
  facts) shift; printf '%s\\n' "$@" "$POLARIS_TEST_VAR" "$(pwd)" ;;
  fail) echo oops >&2; exit 7 ;;
  hang) trap 'exit 42' TERM; echo ready; while :; do sleep 0.05; done ;;
  parent) echo $PPID; cat ;;
  stubborn) trap '' TERM; echo $$; while :; do sleep 0.05; done ;;
  big) head -c 300000 /dev/zero | tr '\\0' x ;;
  status) cat "$0.status" ;;
esac
`;

let root: string;

let helper: string;

const tool = () => join(helper, HELPER_FILES["agent-desktop"]);

beforeAll(async () => {
  root = realpathSync(newTempDir("polaris-cu-", { short: true }));
  helper = join(root, COMPUTER_USE_BUNDLE);
  mkdirSync(dirname(launcherOf(helper)), { recursive: true });
  await compileLauncher(launcherOf(helper));
  writeFileSync(tool(), TOOL);
  chmodSync(tool(), 0o755);
});

afterAll(() => removeTempDir(root));

/** Runs the tool to its end through the service and collects what it wrote. */
const runTool = (request: Omit<HelperRequest, "tool">, stdin = "") =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cu = yield* ComputerUseHelper;
        const running = yield* cu.spawn({ tool: "agent-desktop", ...request });

        if (stdin !== "") running.write(stdin);
        running.end();

        return yield* Effect.promise(async () => ({
          via: running.via,
          stdout: await new Response(running.stdout).text(),
          stderr: await new Response(running.stderr).text(),
          code: await running.exited,
        }));
      })
    ).pipe(Effect.provide(ComputerUseHelper.layerAt(() => helper, { launch: execHelper })))
  );

const firstLine = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let text = "";

  while (!text.includes("\n")) {
    const { value, done } = await reader.read();

    if (done) break;
    text += new TextDecoder().decode(value);
  }

  reader.releaseLock();

  return text.split("\n")[0];
};

const VIAS: ReadonlyArray<SpawnVia> = ["disclaim", "launch-services"];

describe.skipIf(process.platform !== "darwin")("a tool run inside the helper app", () => {
  const through = (via: SpawnVia) => {
    test("keeps its stdio, so a request written to stdin is answered on stdout", async () => {
      const result = await runTool({ args: ["echo"], via }, '{"jsonrpc":"2.0","id":1}\n');

      expect(result).toEqual({ via, stdout: '{"jsonrpc":"2.0","id":1}\n', stderr: "", code: 0 });
    });

    test("gets its arguments, environment and directory", async () => {
      const result = await runTool({
        args: ["facts", "two words", "--flag"],
        env: { PATH: "/usr/bin:/bin", POLARIS_TEST_VAR: "from the Daemon" },
        cwd: root,
        via,
      });

      expect(result.stdout.split("\n")).toEqual([
        "two words",
        "--flag",
        "from the Daemon",
        root,
        "",
      ]);
    });

    test("reports the tool's exit code and stderr", async () => {
      const result = await runTool({ args: ["fail"], via });

      expect(result).toEqual({ via, stdout: "", stderr: "oops\n", code: 7 });
    });

    test("delivers output larger than a socket buffer whole", async () => {
      const result = await runTool({ args: ["big"], via });

      expect(result.stdout.length).toBe(300_000);
      expect(result.code).toBe(0);
    });

    test("a kill reaches the tool, which exits by its own handler", async () => {
      const code = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const cu = yield* ComputerUseHelper;
            const running = yield* cu.spawn({ tool: "agent-desktop", args: ["hang"], via });
            yield* Effect.promise(() => firstLine(running.stdout));
            running.kill();

            return yield* Effect.promise(() => running.exited);
          })
        ).pipe(Effect.provide(ComputerUseHelper.layerAt(() => helper, { launch: execHelper })))
      );

      expect(code).toBe(42);
    });

    test("closing the scope kills a tool that ignores SIGTERM, leaving no orphan", async () => {
      const stopped = await Effect.runPromise(
        Effect.gen(function* () {
          const cu = yield* ComputerUseHelper;

          const running = yield* Effect.scoped(
            Effect.gen(function* () {
              const started = yield* cu.spawn({ tool: "agent-desktop", args: ["stubborn"], via });
              const pid = Number(yield* Effect.promise(() => firstLine(started.stdout)));

              return { pid, exited: started.exited };
            })
          );

          return { pid: running.pid, code: yield* Effect.promise(() => running.exited) };
        }).pipe(Effect.provide(ComputerUseHelper.layerAt(() => helper, { launch: execHelper })))
      );

      expect(stopped.code).toBe(128 + 9);
      expect(() => process.kill(stopped.pid, 0)).toThrow();
    });
  };

  for (const via of VIAS) describe(`through ${via}`, () => through(via));

  test("the disclaimed launcher is its own responsible process, not the Daemon's", async () => {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
    });

    const responsible = symbols.responsibility_get_pid_responsible_for_pid;
    // Without the disclaim a child answers with whoever is responsible for this test run.
    const plain = Bun.spawn([tool(), "parent"], { stdin: "pipe", stdout: "pipe" });
    const plainParent = Number(await firstLine(plain.stdout));
    expect(responsible(plainParent)).toBe(responsible(process.pid));
    void plain.stdin.end();

    const launcher = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cu = yield* ComputerUseHelper;
          const running = yield* cu.spawn({ tool: "agent-desktop", args: ["parent"] });
          const pid = Number(yield* Effect.promise(() => firstLine(running.stdout)));

          return { pid, responsible: responsible(pid) };
        })
      ).pipe(Effect.provide(ComputerUseHelper.layerAt(() => helper)))
    );

    expect(launcher.responsible).toBe(launcher.pid);
    expect(launcher.responsible).not.toBe(responsible(process.pid));
  });

  test.each([["../outside"], ["/bin/sh"], [COMPUTER_USE_LAUNCHER], [".hidden"]])(
    "the launcher refuses %s: only a tool beside it runs",
    async (name) => {
      const proc = Bun.spawn([launcherOf(helper), "run", name], { stderr: "pipe" });

      expect(await proc.exited).toBe(64);
      expect(await new Response(proc.stderr).text()).toContain("polaris-computer-use: the tool");
    }
  );

  test.each([
    ["denied", "needs setup", ["accessibility", "screen recording"]],
    ["granted", "ready", []],
  ] as const)(
    "permissions read %s from the helper's own status as %s",
    async (state, expected, missing) => {
      const permissions = { accessibility: { state }, screen_recording: { state } };
      writeFileSync(`${tool()}.status`, JSON.stringify({ data: { permissions } }));

      const read = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ComputerUseHelper).permissions;
        }).pipe(Effect.provide(ComputerUseHelper.layerAt(() => helper)))
      );

      expect(read).toEqual({ state: expected, missing: [...missing] });
    }
  );

  test("a Daemon with no helper beside it says so instead of running the tool unhelped", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* ComputerUseHelper).spawn({ tool: "agent-desktop", args: [] });
        })
      ).pipe(Effect.flip, Effect.provide(ComputerUseHelper.layerAt(() => null)))
    );

    expect(error.message).toBe("this Daemon has no computer use helper beside it");
  });
});
