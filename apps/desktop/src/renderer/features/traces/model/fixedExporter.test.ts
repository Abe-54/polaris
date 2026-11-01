import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { daemon } from "./daemon.testing.ts";
import { fixedExporterPrompt } from "./agentSetup.ts";
import { FIXED_EXPORTER_CHANGE } from "./setup.ts";

const VENDOR = "https://api.axiom.co/v1/traces";

/** The one-line change run as an app would, in its own process with exactly `env`: its URL. */
const urlUnder = (env: Readonly<Record<string, string | undefined>>): string => {
  const app = join(tmpdir(), `fixed-exporter-${crypto.randomUUID()}.mjs`);

  writeFileSync(
    app,
    `const existingVendorUrl = ${JSON.stringify(VENDOR)};\nconsole.log(({ ${FIXED_EXPORTER_CHANGE} }).url);\n`
  );

  try {
    return Bun.spawnSync([process.execPath, app], { env: { ...env } })
      .stdout.toString()
      .trim();
  } finally {
    rmSync(app);
  }
};

/** What a command gets: the Daemon's whole injection, or the base alone as before ENG-674. */
const ENVIRONMENTS = [
  ["every variable this Daemon injects", (env: Record<string, string>) => env],
  [
    "only the base, as Daemons before ENG-674 inject",
    (env: Record<string, string>) => ({
      OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }),
  ],
] as const;

test.each(ENVIRONMENTS)("the fixed-exporter line reaches the receiver under %s", (_name, given) =>
  daemon.withTraceFixture(async (f) => {
    const env = await Effect.runPromise(f.runtime.environment(f.context.sessionId!, {}));
    const url = urlUnder(given(env));

    const posted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(daemon.traceFixture()),
    });

    expect({ url, status: posted.status }).toEqual({
      url: `${f.endpoint}/v1/traces`,
      status: 200,
    });
  })
);

test("outside Polaris the line keeps the app's own URL; an explicit traces endpoint wins", () => {
  expect(urlUnder({})).toBe(VENDOR);
  expect(urlUnder({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })).toBe(
    "http://collector:4318/v1/traces"
  );
  expect(
    urlUnder({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    })
  ).toBe("http://traces:4318/v1/traces");
});

test("the agent is told to make exactly the line the card shows", () => {
  const prompt = fixedExporterPrompt([
    { kind: "axiom", file: "src/otel.ts", line: 12, runtime: "node", alreadyExporting: false },
  ]);

  expect(prompt.split("\n")).toContain(FIXED_EXPORTER_CHANGE);
});
