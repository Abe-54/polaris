import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SessionId, type VisualsLevel, WorkspaceId } from "@polaris/protocol";
import { VisualizeResult, validateVisualization, visualizeGuidance } from "@polaris/visualization";
import { Effect, Schema } from "effect";
import { McpBinding } from "../binding.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { fakeCommands, leadBinding, workerBinding } from "../testing.ts";
import { attachConstellation } from "../../harness/constellation/attachment.ts";
import { claudeConstellationOptions } from "../../harness/claude/constellation.ts";
import { polarisInstructions } from "../../constellation/skills/preamble.ts";

const plainBinding = McpBinding.cases.Plain.make({
  sessionId: SessionId.make("plain-1"),
  constellationId: leadBinding.constellationId,
  workspaceId: WorkspaceId.make("workspace"),
});

const Text = Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  Schema.decodeUnknownSync(Text)(result.content)
    .map((block) => block.text)
    .join("\n");

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(VisualizeResult));

type Transported = "http" | "claude";

/** A connected MCP client for this binding's attachment, as Codex (HTTP) or Claude sees it. */
const session = async (
  root: string,
  transport: Transported,
  binding: McpBinding,
  visuals: VisualsLevel,
  body: (client: Client, instructions: string) => Promise<void>
) => {
  const commands = fakeCommands().commands;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* mcpHttp(commands);
        const attachment = yield* attachConstellation(binding, origin, commands, visuals);
        const server = claudeConstellationOptions([attachment]).mcpServers?.polaris;

        if (server === undefined || server.type !== "sdk") throw new Error("Missing SDK server");
        const client = new Client({ name: "visualize-test", version: "1" });

        yield* Effect.promise(async () => {
          try {
            if (transport === "http") {
              // SAFETY: the SDK transport contract differs only by sessionId's undefined under exactOptionalPropertyTypes.
              await client.connect(
                new StreamableHTTPClientTransport(new URL(attachment.url)) as Transport
              );
            } else {
              const [local, remote] = InMemoryTransport.createLinkedPair();
              await server.instance.connect(remote);
              await client.connect(local);
            }

            await body(client, polarisInstructions({ constellation: attachment }));
          } finally {
            await client.close();
            await server.instance.close();
          }
        });
      })
    ).pipe(Effect.provide(McpTokens.layer(join(root, "tokens.sqlite"))))
  );
};

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = newTempDir("polaris-visualize-", { short: true });

  try {
    await body(root);
  } finally {
    removeTempDir(root);
  }
};

const show = (client: Client, input: Record<string, string>) =>
  client.callTool({ name: "visualize", arguments: input });

for (const transport of ["http", "claude"] as const)
  for (const binding of [plainBinding, leadBinding, workerBinding])
    test(`a ${binding._tag} binding over ${transport} shows a Visualization and replaces it by id`, () =>
      withRoot((root) =>
        session(root, transport, binding, "rich", async (client, instructions) => {
          const listed = (await client.listTools()).tools.find((t) => t.name === "visualize");
          expect(listed?.annotations?.readOnlyHint).toBe(true);
          expect(instructions).toContain(visualizeGuidance("rich"));

          const first = await show(client, { title: "Coverage", html: "<p>é</p>" });
          expect(first.isError).not.toBe(true);
          const shown = decodeResult(textOf(first));
          expect(shown).toMatchObject({ title: "Coverage", bytes: 9 });

          const second = await show(client, {
            title: "Coverage, by package",
            html: "<p>2</p>",
            replaces: shown.id,
          });

          expect(second.isError).not.toBe(true);
          expect(decodeResult(textOf(second)).id).not.toBe(shown.id);
        })
      ));

test("replaces must name an earlier Visualization of this session, even after a restart", () =>
  withRoot(async (root) => {
    let id = "";

    await session(root, "http", workerBinding, "rich", async (client) => {
      id = decodeResult(textOf(await show(client, { title: "A", html: "<p>a</p>" }))).id;

      const unknown = await show(client, { title: "B", html: "<p>b</p>", replaces: "viz_nope" });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain(
        "Fix: Use the id an earlier visualize call in this session returned, or leave replaces out to show a new one."
      );
    });

    // A new Daemon over the same store: the same session may still replace it, another may not.
    await session(root, "claude", workerBinding, "rich", async (client) => {
      const again = await show(client, { title: "B", html: "<p>b</p>", replaces: id });
      expect(again.isError).not.toBe(true);
    });

    await session(root, "claude", leadBinding, "rich", async (client) => {
      const foreign = await show(client, { title: "C", html: "<p>c</p>", replaces: id });
      expect(foreign.isError).toBe(true);
      expect(textOf(foreign)).toContain("E-VISUAL-REPLACES");
    });
  }));

// Over HTTP: Claude's SDK server strips unknown keys before the call reaches the tool.
test("an input outside VisualizeInput is refused with the fields to send", () =>
  withRoot((root) =>
    session(root, "http", workerBinding, "rich", async (client) => {
      const result = await client.callTool({
        name: "visualize",
        arguments: { title: "A", html: "<p>a</p>", requestId: "r1" },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Fix: Send title and html as strings");
    })
  ));

for (const transport of ["http", "claude"] as const)
  test(`Visuals off leaves visualize and its guidance out over ${transport}`, () =>
    withRoot((root) =>
      session(root, transport, workerBinding, "off", async (client, instructions) => {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("claim");
        expect(names).not.toContain("visualize");
        expect(instructions).not.toContain("visualize");

        const called = await show(client, { title: "A", html: "<p>a</p>" }).then(
          (result) => result.isError === true,
          () => true
        );

        expect(called).toBe(true);
      })
    ));

for (const level of ["rich", "simple"] as const)
  test(`a session opened with Visuals ${level} gets that level's guidance`, () =>
    withRoot((root) =>
      session(root, "claude", workerBinding, level, async (_client, instructions) => {
        expect(instructions).toContain(visualizeGuidance(level));
      })
    ));

for (const transport of ["http", "claude"] as const)
  test(`invalid HTML over ${transport} is refused with every problem's message and fix`, () =>
    withRoot((root) =>
      session(root, transport, workerBinding, "rich", async (client) => {
        const input = {
          title: "Remote",
          html: '<!doctype html><html><body><script src="https://cdn.example/x.js"></script></body></html>',
        };

        const problems = validateVisualization(input);
        const rules = problems.map((p) => p.rule);
        expect(rules).toContain("full-document");
        expect(rules).toContain("external-url");

        const result = await show(client, input);
        expect(result.isError).toBe(true);
        const text = textOf(result);

        for (const problem of problems) {
          expect(text).toContain(`E-VISUAL-${problem.rule.toUpperCase()}: ${problem.message}`);
          expect(text).toContain(`Fix: ${problem.fix}`);
        }
      })
    ));
