import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Predicate, Stream } from "effect";
import { awaitReady, connect, launchDaemon } from "../../../../packages/bench/src/daemon.ts";
import { registerWorkspace } from "../../../../packages/bench/src/drive.ts";

const sentinels = ["AXIOM_URL", "SEC1_DOTENV_SENTINEL", "SEC1_BUNFIG_SENTINEL"];

/** Start the actual Daemon from a repository-like cwd without inheriting this probe's sentinels. */
const launch = async (binary: string | null, root: string) => {
  const previousDirectory = process.cwd();
  const previous = sentinels.map((key) => [key, process.env[key]] as const);

  for (const key of sentinels) delete process.env[key];
  process.chdir(root);

  try {
    return await launchDaemon({
      binary,
      home: join(root, "home"),
      env: {
        POLARIS_HOST_SOCKET: join(root, "home", "daemon.sock"),
        NODE_OPTIONS: "",
        BUN_OPTIONS: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_HEADERS: "",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "",
        AXIOM_OTLP_ENDPOINT: "",
        AXIOM_DOMAIN: "",
        AXIOM_TOKEN: "smoke-launch-token",
        AXIOM_DATASET: "smoke-launch-dataset",
        VERCEL_OTEL_ENDPOINT: "",
        VERCEL_OTEL_ENDPOINTS: "",
      },
    });
  } finally {
    process.chdir(previousDirectory);

    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** Compiled smoke; `dev` observes the source runner separately and must not be mistaken for a pass. */
export const compiledEnvironmentSmoke = async (binary: string | null) => {
  if (process.env.POLARIS_LEASE_HELD !== "bench")
    throw new Error("Run this smoke under lease bench");
  const root = await mkdtemp("/tmp/sec1-compiled-");
  const checkout = join(root, "app");
  await mkdir(checkout);
  await writeFile(
    join(root, ".env"),
    "AXIOM_URL=http://127.0.0.1:9\nSEC1_DOTENV_SENTINEL=repository-value\n"
  );
  await writeFile(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await writeFile(
    join(root, "preload.ts"),
    'import {writeFileSync} from "node:fs"; process.env.SEC1_BUNFIG_SENTINEL="repository-preload"; writeFileSync("preload-ran", "yes");'
  );
  const daemon = await launch(binary, root);

  try {
    await Effect.runPromise(awaitReady(daemon));

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(daemon, "socket", "SEC1 compiled environment smoke");
          const rpc = client.connection.client;
          const workspaceId = yield* registerWorkspace(client, checkout, "SEC1 smoke");
          const settings = yield* rpc["traces.settings"]({ workspaceId });

          const { terminalId } = yield* rpc["terminal.open"]({
            cwd: checkout,
            argv: [
              "node",
              "-e",
              "console.log(JSON.stringify({dotenv:process.env.SEC1_DOTENV_SENTINEL??null,bunfig:process.env.SEC1_BUNFIG_SENTINEL??null,axiom:process.env.AXIOM_URL??null}))",
            ],
            cols: 80,
            rows: 24,
          });

          const output = yield* rpc["terminal.attach"]({ terminalId }).pipe(Stream.runCollect);

          const text = output
            .filter((item) => Predicate.isTagged(item, "Output"))
            .map((item) => new TextDecoder().decode(item.data))
            .join("")
            .trim();

          const exit = output.find((item) => Predicate.isTagged(item, "Exit"));
          yield* rpc["terminal.close"]({ terminalId });

          return { forwardTo: settings.forwardTo?.url ?? null, child: text, exit: exit?.code };
        })
      )
    );

    const preloadRan = await readFile(join(root, "preload-ran"), "utf8").catch(() => null);
    console.log(
      JSON.stringify({ mode: binary === null ? "dev" : "compiled", ...observed, preloadRan })
    );

    if (
      observed.forwardTo !== "https://api.axiom.co/v1/traces" ||
      observed.child !== '{"dotenv":null,"bunfig":null,"axiom":null}' ||
      observed.exit !== 0 ||
      preloadRan !== null
    )
      throw new Error("Repository startup configuration entered the Daemon environment");
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const target = process.argv[2];

  if (target === undefined)
    throw new Error("Pass the compiled binary path, or dev for the source probe");
  await compiledEnvironmentSmoke(target === "dev" ? null : resolve(target));
}
