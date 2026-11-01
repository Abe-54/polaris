import { expect, test } from "bun:test";
import { harnessEnv } from "./environment.ts";

for (const mixedCase of [false, true]) {
  test(`Harness and MCP children strip instrumentation (${mixedCase ? "mixed-case" : "canonical"} names)`, async () => {
    const source = {
      PATH: process.env.PATH,
      [mixedCase ? "Node_Options" : "NODE_OPTIONS"]:
        '--no-warnings --import "file:///tmp/node-instrumentation/old/register.mjs"',
      [mixedCase ? "Polaris_Otel_Endpoint" : "POLARIS_OTEL_ENDPOINT"]:
        "http://127.0.0.1:4319/otlp/private",
      POLARIS_OTEL_SERVICE_NAME: "app",
      POLARIS_OTEL_FUTURE: "private",
      POLARIS_HANDOFF: "private",
    };

    const child = Bun.spawn(
      [
        "node",
        "-e",
        `const {execFileSync}=require('node:child_process');
    console.log(JSON.stringify({own:process.env, mcp:JSON.parse(execFileSync(process.execPath,
      ['-e', 'console.log(JSON.stringify(process.env))'], {encoding:'utf8'}))}));`,
      ],
      { env: harnessEnv(source), stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.toUpperCase()).not.toContain("POLARIS_OTEL_");
    expect(stdout).not.toContain("node-instrumentation");
    expect(stdout).not.toContain("POLARIS_HANDOFF");
    expect(stdout.match(/--no-warnings/g)).toHaveLength(2);
  });
}
