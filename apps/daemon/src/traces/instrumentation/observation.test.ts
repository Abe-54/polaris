import { expect, test } from "bun:test";
import { applicationCommand, applicationProgram } from "./observation.ts";

for (const [command, expected] of [
  ["node --version", false],
  ["npm install", false],
  ["pnpm add @opentelemetry/sdk-node", false],
  ["bun build app.ts", false],
  ["deno fmt", false],
  ["echo node app.mjs", false],
  ["node app.mjs", true],
  ["cd package && /usr/bin/node app.mjs", true],
  ["NODE_ENV=development npm run dev", true],
  ["deno run app.ts", true],
  ["bun test", true],
] as const) {
  test(`application evidence: ${command}`, () => {
    expect(applicationCommand(command)).toBe(expected);
  });
}

test("direct argv evidence recognizes script launches without treating package installation as an app", () => {
  expect(applicationProgram("/usr/bin/node", ["/tmp/app here.mjs"])).toBe(true);
  expect(applicationProgram("npm", ["install"])).toBe(false);
  expect(applicationProgram("/bin/sh", ["-c", "node app.mjs"])).toBe(false);
});
