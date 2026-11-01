import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, loadavg, cpus } from "node:os";
import { join } from "node:path";
import { buildInstrumentationAssets } from "./build.ts";
import { materializeInstrumentation } from "./assets.ts";
import { appendNodeImport, instrumentationImport } from "../nodeOptions.ts";
import { executableOf } from "../../platform/executable.ts";

const home = await mkdtemp(join(tmpdir(), "uf11-startup-"));

try {
  const assets = await buildInstrumentationAssets();
  const register = await materializeInstrumentation(assets, home);
  const preload = appendNodeImport(undefined, instrumentationImport(register));

  const cases = [
    { name: "plain", environment: {} },
    { name: "preloadWithoutEndpoint", environment: { NODE_OPTIONS: preload } },
    {
      name: "preloadWithEndpoint",
      environment: { NODE_OPTIONS: preload, POLARIS_OTEL_ENDPOINT: "http://127.0.0.1:1" },
    },
  ];

  const samples: Record<string, number[]> = Object.fromEntries(
    cases.map((entry) => [entry.name, []])
  );

  const node = executableOf("node");

  for (let iteration = 0; iteration < 30; iteration++) {
    for (let offset = 0; offset < cases.length; offset++) {
      const entry = cases[(iteration + offset) % cases.length]!;
      const started = performance.now();

      const child = Bun.spawn([node, "-e", "0"], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...entry.environment },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      const elapsed = performance.now() - started;

      if (code !== 0 || stderr) throw new Error(`${entry.name}: ${code} ${stderr}`);

      if (iteration >= 5) samples[entry.name]!.push(elapsed);
    }
  }

  const summary = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => {
      const sorted = values.toSorted((a, b) => a - b);

      return [
        name,
        {
          medianMs: sorted[Math.floor(sorted.length / 2)],
          minMs: sorted[0],
          maxMs: sorted.at(-1),
          totalMs: values.reduce((sum, value) => sum + value, 0),
        },
      ];
    })
  );

  const result = {
    measuredAt: new Date().toISOString(),
    node: Bun.spawnSync([node, "--version"]).stdout.toString().trim(),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    loadAverageAtEnd: loadavg(),
    warmupsPerCase: 5,
    samples,
    summary,
    bytes: Object.fromEntries(
      Object.entries(assets).map(([name, source]) => [name, Buffer.byteLength(source)])
    ),
  };

  if (process.argv[2]) await Bun.write(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(home, { recursive: true, force: true });
}
