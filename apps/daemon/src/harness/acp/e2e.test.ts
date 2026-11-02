/**
 * Runs one tiny real Turn against an installed ACP Harness (uses its own
 * sign-in and quota). Opt in with the catalogue Harness to drive:
 *
 *   POLARIS_E2E_ACP=copilot bun test apps/daemon/src/harness/acp/e2e.test.ts
 *
 * `POLARIS_E2E_ACP_ARGV='["/path/to/agent", "--flag"]'` runs another ACP agent
 * (an adapter such as codex-acp) under that Harness's driver instead.
 */
import { expect, test } from "bun:test";
import { ApprovalDecision, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeAcpDriver } from "./AcpDriver.ts";
import { ACP_HARNESSES } from "./harnesses.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const harness = ACP_HARNESSES.find((h) => h.kind === process.env.POLARIS_E2E_ACP);

const argv = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Schema.Array(Schema.String)))
)(process.env.POLARIS_E2E_ACP_ARGV ?? "null");

test.skipIf(harness === undefined)(
  "a real ACP Turn: reply with the word pong",
  async () => {
    if (harness === undefined) return;
    const repo = newTempDir("polaris-acp-e2e-");
    await Bun.$`git init -q && git commit -q --allow-empty -m init`.cwd(repo);

    try {
      const program = Effect.gen(function* () {
        const driver = yield* makeAcpDriver({
          harness: argv === null ? harness : { ...harness, acpArgs: argv.slice(1) },
          binaryPath: () => argv?.[0] ?? Bun.which(harness.binary),
        });

        const models = yield* driver.listModels ?? Effect.succeed([]);

        const session = yield* driver.open({
          sessionId: SessionId.make("e2e"),
          cwd: repo,
          permissionMode: "supervised",
          model: null,
          effort: null,
          resumeCursor: null,
        });

        yield* session.sendTurn({
          turnId: TurnId.make("turn-1"),
          prompt: "Reply with exactly the word pong. Do not run commands or edit files.",
          attachments: [],
          model: null,
          effort: null,
        });

        const events = yield* session.events.pipe(
          Stream.tap((event) =>
            HarnessEvent.$is("ApprovalRequested")(event)
              ? session.respond(event.requestId, ApprovalDecision.cases.Deny.make({ reason: null }))
              : Effect.void
          ),
          Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
          Stream.runCollect
        );

        return { events: Array.from(events), models };
      });

      const { events, models } = await Effect.runPromise(Effect.scoped(program));

      console.log(`${models.length} Models; ${events.map((e) => e._tag).join(" ")}`);
      expect(events.find(HarnessEvent.$is("CursorAssigned"))).toBeDefined();
      expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({
        turnId: "turn-1",
        status: "completed",
        error: null,
      });

      const reply = events
        .filter(HarnessEvent.$is("ItemCompleted"))
        .flatMap(({ item }) => (TurnItem.guards.AssistantMessage(item) ? [item.text] : []));

      expect(reply.join(" ").toLowerCase()).toContain("pong");
    } finally {
      removeTempDir(repo);
    }
  },
  180_000
);
