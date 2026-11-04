/** `terminal.open` through the real handler, store and terminals: whose environment a terminal gets. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  DomainEvent,
  PullRequestRef,
  RepoRef,
  ReviewCheckout,
  ReviewCheckoutId,
  ReviewSubject,
  TerminalAttach,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { makeFakeBlobChannel } from "../files/testing.ts";
import { removeTempDir, tempDir } from "../git/testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { TerminalRpcs, TerminalRpcsLive } from "./TerminalRpcs.ts";
import { TerminalsLive } from "./Terminals.ts";

/** Named like the secrets a Daemon may hold; the values are markers, not credentials. */
const AMBIENT = {
  OPENAI_API_KEY: "marker-openai",
  ANTHROPIC_API_KEY: "marker-anthropic",
  GITHUB_TOKEN: "marker-github",
  SSH_AUTH_SOCK: "/tmp/marker-agent.sock",
  POLARIS_TEST_MARKER: "marker-polaris",
};

const cleanup: Array<string> = [];

afterEach(() => {
  for (const key of Object.keys(AMBIENT)) delete process.env[key];

  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const at = "2026-10-01T00:00:00.000Z";

const checkoutAt = (path: string) =>
  new ReviewCheckout({
    id: ReviewCheckoutId.make("rc"),
    workspaceId: WorkspaceId.make("ws"),
    subject: ReviewSubject.cases.PullRequest.make({
      pullRequest: new PullRequestRef({
        repo: new RepoRef({ host: "github.com", owner: "acme", name: "app" }),
        number: 7,
      }),
      baseRef: "main",
    }),
    path,
    state: "ready",
    blocked: null,
    head: "h",
    mergeBase: "m",
    latestHead: "h",
    latestBase: "b",
    reviewedHead: null,
    reviewedMergeBase: null,
    openedAt: at,
    updatedAt: at,
  });

const Attached = TerminalAttach.successSchema.success;

const windows = process.platform === "win32";

/** Prints the environment; `cmd /c set` on Windows. */
const PRINT_ENV = windows ? ["cmd.exe", "/d", "/c", "set"] : ["/usr/bin/env"];

/** Opens `env` in each cwd after recording a Review Checkout at `checkout`; answers each output. */
const envIn = (checkout: string, cwds: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.commit({
          commandId: null,
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.ReviewCheckoutOpened.make({ checkout: checkoutAt(checkout) }),
            ]),
        });
        const client = yield* RpcTest.makeClient(TerminalRpcs);

        return yield* Effect.forEach(cwds, (cwd) =>
          Effect.gen(function* () {
            const { terminalId } = yield* client["terminal.open"]({
              cwd,
              cols: 200,
              rows: 50,
              argv: PRINT_ENV,
            });

            const items = yield* client["terminal.attach"]({ terminalId }).pipe(
              Stream.runCollect,
              Effect.timeout("5 seconds")
            );

            return items
              .map((item) =>
                Attached.guards.Output(item) ? new TextDecoder().decode(item.data) : ""
              )
              .join("");
          })
        );
      }).pipe(
        Effect.provide(
          TerminalRpcsLive.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                TerminalsLive,
                EventStore.layerSqlite(":memory:"),
                makeFakeBlobChannel().layer
              )
            )
          )
        )
      )
    )
  );

describe("terminal.open", () => {
  test("a Review Checkout's terminals get only the allowlist; others keep the user's environment", async () => {
    Object.assign(process.env, AMBIENT);
    const root = tempDir("polaris-review-env-");
    cleanup.push(root);
    const checkout = join(root, "pr-7");
    mkdirSync(join(checkout, "src"), { recursive: true });
    symlinkSync(checkout, join(root, "linked"), "junction");
    const elsewhere = join(root, "workspace");
    mkdirSync(elsewhere);

    // Recorded through the link, opened through either path: both sides are compared canonically.
    const [inside, nested, linked, outside] = await envIn(join(root, "linked"), [
      checkout,
      join(checkout, "src"),
      join(root, "linked"),
      elsewhere,
    ]);

    for (const output of [inside!, nested!, linked!]) {
      for (const value of Object.values(AMBIENT)) expect(output).not.toContain(value);

      // ConPTY wraps a long PATH at the terminal's width, so Windows checks a short base key;
      // its names ignore case, and under Git Bash MSYS upper-cases them (SYSTEMROOT).
      if (windows)
        expect(output.toLowerCase()).toContain(
          `systemroot=${process.env.SystemRoot}`.toLowerCase()
        );
      else {
        expect(output).toContain(`PATH=${process.env.PATH}`);
        expect(output).toContain(`HOME=${process.env.HOME}`);
        expect(output).toContain("TERM=xterm-256color");
      }
    }

    for (const value of Object.values(AMBIENT)) expect(outside).toContain(value);
  }, 20_000);
});
