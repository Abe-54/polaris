/** The installed Claude binary and permission engine, with a scripted Messages API boundary. */
import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ApprovalDecision, DomainEvent } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { commit, turn } from "../../traces/authority.testing.ts";
import { withInstrumentation } from "../../traces/instrumentation/integration.testing.ts";
import { TraceSettings } from "../../traces/settings.ts";
import { TraceStore } from "../../traces/store.ts";
import { TEST_SESSION, TEST_WORKSPACE } from "../../traces/testing.ts";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { fakeAnthropic, bash } from "./fakeAnthropic.testing.ts";

test.skipIf(process.env.POLARIS_E2E_CLAUDE_TRACE !== "1")(
  "default-mode permissions and remembered rules see the original Bash command; approved Node launches trace",
  () =>
    withInstrumentation(async (f) => {
      await writeFile(join(f.checkout, "package.json"), '{"name":"permission-node-app"}');
      await mkdir(join(f.home, "claude"));
      const mcpEnv = join(f.home, "mcp-env.json");
      const mcp = join(f.home, "mcp.mjs");
      await writeFile(
        mcp,
        `import fs from 'node:fs'; import readline from 'node:readline';
      fs.writeFileSync(${JSON.stringify(mcpEnv)},JSON.stringify(process.env));
      readline.createInterface({input:process.stdin}).on('line', line => {
        const request=JSON.parse(line); if(request.id === undefined) return;
        const result=request.method==='initialize'
          ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}
          : {tools:[]};
        console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
      });`
      );
      await writeFile(
        join(f.checkout, "app.mjs"),
        `import http from 'node:http';
      console.log('instrumented:'+Boolean(process.env.POLARIS_OTEL_ENDPOINT));
      const server=http.createServer((_req,res)=>res.end('trace-permission-ok'));
      server.listen(0,'127.0.0.1',async()=>{
        console.log(await (await fetch('http://127.0.0.1:'+server.address().port+'/app')).text());
        server.close();
      });`
      );
      const command = "node app.mjs";
      const api = fakeAnthropic([bash(command), bash(command)]);
      const scope = Effect.runSync(Scope.make());
      const permissionInputs: unknown[] = [];
      const suggestions: unknown[] = [];
      const events: HarnessEvent[] = [];

      try {
        const driver = makeClaudeDriver({
          query: (params) => {
            const original = params.options!.canUseTool!;

            return query({
              ...params,
              options: {
                ...params.options,
                settingSources: ["local"],
                persistSession: false,
                maxTurns: 5,
                mcpServers: { probe: { command: "node", args: [mcp] } },
                canUseTool: async (name, input, context) => {
                  permissionInputs.push(input);
                  suggestions.push(context.suggestions);

                  return original(name, input, context);
                },
              },
            });
          },
        });

        const launched = turn(2);
        await f.runtime.runPromise(
          Effect.gen(function* () {
            const settings = yield* TraceSettings;
            yield* settings.patch(TEST_WORKSPACE, { autoInstrument: "node", forwarding: false });
            yield* commit([DomainEvent.cases.TurnStarted.make({ turn: launched })]);
          })
        );

        const session = await f.runtime.runPromise(
          driver
            .open({
              sessionId: TEST_SESSION,
              cwd: f.checkout,
              permissionMode: "supervised",
              model: null,
              effort: null,
              resumeCursor: null,
              environment: {
                CLAUDE_CONFIG_DIR: join(f.home, "claude"),
                ANTHROPIC_API_KEY: "fake",
                ANTHROPIC_BASE_URL: api.url,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              },
            })
            .pipe(Scope.provide(scope))
        );

        const eventLoop = Effect.runPromise(
          Stream.runForEach(session.events, (event) =>
            Effect.gen(function* () {
              events.push(event);

              if (HarnessEvent.$is("ApprovalRequested")(event))
                yield* session.respond(
                  event.requestId,
                  ApprovalDecision.cases.Allow.make({ remember: true })
                );
            })
          )
        );

        await Effect.runPromise(
          session.sendTurn({
            turnId: launched.id,
            prompt: "Run the requested commands",
            attachments: [],
            model: null,
            effort: null,
          })
        );

        for (let i = 0; i < 450 && !events.some(HarnessEvent.$is("TurnEnded")); i++)
          await Bun.sleep(100);
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await eventLoop;
        expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({ status: "completed" });
        expect(permissionInputs).toEqual([{ command, description: "probe" }]);
        expect(
          events.flatMap((event) =>
            HarnessEvent.$is("ApprovalRequested")(event) ? [event.detail] : []
          )
        ).toEqual([command]);
        expect(JSON.stringify(suggestions)).toContain('"ruleContent":"node app.mjs"');
        expect(api.outputs).toHaveLength(2);
        expect(api.outputs[0]).toContain("instrumented:true");
        expect(api.outputs[1]).toContain("instrumented:false");
        expect(api.outputs.every((output) => output.includes("trace-permission-ok"))).toBe(true);
        const environment = await readFile(mcpEnv, "utf8");
        expect(environment).not.toContain("POLARIS_OTEL_");
        expect(environment).not.toContain("node-instrumentation");

        const spans = await f.runtime.runPromise(
          Effect.gen(function* () {
            const store = yield* TraceStore;
            const page = yield* store.list(f.checkout);

            const all = yield* Effect.forEach(page.traces, (trace) =>
              store.get(f.checkout, trace.id)
            );

            return all.flatMap((trace) => trace.spans);
          })
        );

        expect(spans.some((span) => span.kind === "server")).toBe(true);
        expect(spans.every((span) => span.polaris.launchedTurn?.id === launched.id)).toBe(true);
        console.log(
          JSON.stringify({
            permissionInputs,
            suggestions,
            approvals: events.flatMap((e) =>
              HarnessEvent.$is("ApprovalRequested")(e) ? [e.detail] : []
            ),
            spans: spans.length,
            outputs: api.outputs,
          })
        );
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        api.stop();
      }
    }),
  60000
);
