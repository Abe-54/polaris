/**
 * Language-server memory (ENG-288): drives the Host's managed sqllens or
 * bash-language-server over LSP stdio, launched as `sqlShellLaunch` launches
 * it, and samples its process tree through phases: open, idle, typing, idle,
 * typing again, idle. Steady state shows as equal idle windows; growth as a
 * step between them.
 *
 *   bun packages/bench/src/languageServerMemory.ts sql|bash [--lines 400] [--idle-s 60]
 *     [--typing-s 60] [--node-flags=--max-semi-space-size=1] [--json PATH]
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { startSampler, type TreeReport } from "./sampler.ts";

const MiB = 1024 * 1024;

const Manifest = Schema.fromJsonString(Schema.Struct({ artifactId: Schema.String }));

const LspMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
    method: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
  })
);

const ConfigurationParams = Schema.Struct({ items: Schema.Array(Schema.Unknown) });

type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

interface Params {
  readonly [key: string]: Json;
}

interface Outgoing {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Params;
  readonly result?: ReadonlyArray<null> | null;
}

/** The payload directory of the Host's managed artifact whose id starts with `prefix`. */
const managed = (prefix: string): string => {
  const languages = join(process.env.POLARIS_HOME ?? join(homedir(), ".polaris"), "languages");

  for (const tool of readdirSync(languages)) {
    const versions = join(languages, tool, "versions");

    const entries = (() => {
      try {
        return readdirSync(versions);
      } catch {
        return [];
      }
    })();

    for (const version of entries) {
      const dir = join(versions, version);

      const { artifactId } = Schema.decodeUnknownSync(Manifest)(
        readFileSync(join(dir, "receipt.json"), "utf8")
      );

      if (artifactId.startsWith(prefix)) return join(dir, "payload");
    }
  }

  throw new Error(`no managed ${prefix} under ${languages}`);
};

const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);

  return at < 0 ? fallback : Number(process.argv[at + 1]);
};

/** Extra V8 flags placed before the entry, e.g. `--node-flags=--max-semi-space-size=1`. */
const nodeFlags = () =>
  process.argv
    .filter((arg) => arg.startsWith("--node-flags="))
    .flatMap((arg) => arg.slice("--node-flags=".length).split(" "));

const shellcheckPath = () => Bun.which("shellcheck") ?? "";

interface Target {
  readonly languageId: string;
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Record<string, string>;
  readonly initializationOptions: Json;
}

const sqlText = (lines: number) =>
  Array.from(
    { length: lines },
    (_, i) =>
      `SELECT u.id, u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE o.total > ${i} ORDER BY o.total DESC;`
  ).join("\n");

const bashText = (functions: number) =>
  Array.from(
    { length: functions },
    (_, i) =>
      `deploy_${i}() {\n  local target=$1\n  for f in $(ls $target); do\n    echo "copy $f to \${HOST}"\n    cp $f /tmp/out_${i}\n  done\n}`
  ).join("\n\n");

const target = (kind: string, workspace: string): Target => {
  const node = join(managed("node-"), "bin", "node");

  const shared = {
    NODE_OPTIONS: "",
    NODE_PATH: "",
    PATH: join(node, ".."),
    SQLLENS_NO_PLUGINS: "1",
    SQLLENS_TRACE_SYNC: "",
    EXPLAINSHELL_ENDPOINT: "",
    BACKGROUND_ANALYSIS_MAX_FILES: "0",
    SHELLCHECK_EXTERNAL_SOURCES: "false",
    SHFMT_IGNORE_EDITORCONFIG: "true",
  };

  if (kind === "sql") {
    const server = managed("sqllens-language-server");
    const file = join(workspace, "queries.sql");
    writeFileSync(file, sqlText(flag("--lines", 400)));

    return {
      languageId: "sql",
      file,
      args: [node, ...nodeFlags(), join(server, "polaris-sql.mjs"), "--stdio"],
      environment: {
        ...shared,
        SQLLENS_USER_CONFIG: join(server, "polaris-no-user-config.json"),
        POLARIS_SQL_DIALECT: "postgresql",
        POLARIS_SQL_FORMATTER: join(managed("sql-formatter"), "dist/cjs/index.js"),
      },
      initializationOptions: null,
    };
  }

  const server = managed("bash-language-server");
  const shfmt = join(managed("shfmt"), "shfmt");
  const file = join(workspace, "deploy.sh");
  writeFileSync(file, `#!/usr/bin/env bash\n${bashText(flag("--lines", 400) / 5)}\n`);

  return {
    languageId: "shellscript",
    file,
    args: [node, ...nodeFlags(), join(server, "out/cli.js"), "start"],
    environment: { ...shared, SHELLCHECK_PATH: shellcheckPath(), SHFMT_PATH: shfmt },
    initializationOptions: {
      shellcheckPath: shellcheckPath(),
      shellcheckExternalSources: false,
      shellcheckArguments: ["--norc"],
      explainshellEndpoint: "",
      backgroundAnalysisMaxFiles: 0,
      shfmt: { path: shfmt, ignoreEditorconfig: true },
    },
  };
};

/** A minimal LSP client over the server's stdio; answers the server's own requests. */
const connect = (proc: Bun.Subprocess<"pipe", "pipe", "ignore">) => {
  const pending = new Map<number | string, () => void>();
  let next = 1;
  let buffer = Buffer.alloc(0);

  const write = (message: Outgoing) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    void proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    void proc.stdin.write(body);
    void proc.stdin.flush();
  };

  /** Answers a server request: `null` per item for `workspace/configuration`, else `null`. */
  const handle = (text: string) => {
    const message = Schema.decodeUnknownSync(LspMessage)(text);

    if (message.id === undefined) return;

    if (message.method === "workspace/configuration") {
      const { items } = Schema.decodeUnknownSync(ConfigurationParams)(message.params);

      return write({ id: message.id, result: items.map(() => null) });
    }

    if (message.method !== undefined) return write({ id: message.id, result: null });

    pending.get(message.id)?.();
  };

  void (async () => {
    for await (const chunk of proc.stdout) {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        const header = buffer.indexOf("\r\n\r\n");

        if (header < 0) break;

        const length = Number(
          /Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())?.[1]
        );

        if (buffer.length < header + 4 + length) break;
        handle(buffer.subarray(header + 4, header + 4 + length).toString());
        buffer = buffer.subarray(header + 4 + length);
      }
    }
  })();

  const request = (method: string, params: Params) =>
    new Promise<void>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      write({ id, method, params });
    });

  const notify = (method: string, params: Params) => write({ method, params });

  return { request, notify };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const summary = (label: string, report: TreeReport) => ({
  label,
  rss_median_mib: report.rssBytes.median / MiB,
  rss_max_mib: report.rssBytes.max / MiB,
  footprint_median_mib: (report.footprintBytes?.median ?? 0) / MiB,
  footprint_max_mib: (report.footprintBytes?.max ?? 0) / MiB,
  cpu_avg_pct: report.cpuAvgPct,
  wakeups_per_s: report.wakeupsPerSec,
  max_processes: report.maxProcesses,
  processes: report.processes.map((p) => ({
    name: p.name,
    max_rss_mib: p.maxRssBytes / MiB,
    cpu_s: p.cpuSeconds,
  })),
});

/** Types into the document for `seconds`: an edit every 250 ms, a completion and a hover every second. */
const type = async (
  lsp: ReturnType<typeof connect>,
  uri: string,
  text: string,
  seconds: number,
  version: { value: number }
) => {
  let current = text;

  for (let tick = 0; tick < seconds * 4; tick++) {
    current += tick % 8 === 7 ? "\n" : " x";
    version.value++;
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: version.value },
      contentChanges: [{ text: current }],
    });

    if (tick % 4 === 0) {
      const lines = current.split("\n");
      const position = { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
      void lsp.request("textDocument/completion", { textDocument: { uri }, position });
      void lsp.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: 1, character: 4 },
      });
    }

    await sleep(250);
  }

  return current;
};

const main = async () => {
  const kind = process.argv[2] ?? "sql";
  const idleS = flag("--idle-s", 60);
  const typingS = flag("--typing-s", 60);
  const workspace = mkdtempSync(join(tmpdir(), "polaris-ls-mem-"));
  const spec = target(kind, workspace);

  const proc = Bun.spawn([...spec.args], {
    cwd: workspace,
    env: spec.environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const sampler = startSampler({ roots: () => [proc.pid], intervalMs: 50 });
  const lsp = connect(proc);
  const uri = pathToFileURL(spec.file).href;
  const version = { value: 1 };
  const marks: Array<[string, number, number]> = [];

  const phase = async (label: string, run: () => Promise<void>) => {
    const from = sampler.now();
    await run();
    marks.push([label, from, sampler.now()]);
  };

  let text = readFileSync(spec.file, "utf8");

  await phase("initialize", async () => {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(workspace).href,
      capabilities: { textDocument: { completion: {}, hover: {}, publishDiagnostics: {} } },
      initializationOptions: spec.initializationOptions,
    });
    lsp.notify("initialized", {});
    await sleep(5000);
  });
  await phase("open", async () => {
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: spec.languageId, version: version.value, text },
    });
    await sleep(5000);
  });
  await phase("idle1", () => sleep(idleS * 1000));
  await phase("typing1", async () => {
    text = await type(lsp, uri, text, typingS, version);
  });
  await phase("idle2", () => sleep(idleS * 1000));
  await phase("typing2", async () => {
    text = await type(lsp, uri, text, typingS, version);
  });
  await phase("idle3", () => sleep(idleS * 1000));

  const result = {
    kind,
    node_flags: nodeFlags(),
    lines: flag("--lines", 400),
    idle_s: idleS,
    typing_s: typingS,
    phases: marks.map(([label, from, to]) => summary(label, sampler.report(from, to))),
  };

  sampler.stop();
  proc.kill();
  rmSync(workspace, { recursive: true, force: true });

  const at = process.argv.indexOf("--json");

  if (at >= 0) writeFileSync(process.argv[at + 1] ?? "", `${JSON.stringify(result, null, 2)}\n`);

  for (const p of result.phases)
    console.log(
      `${p.label.padEnd(10)} rss ${p.rss_median_mib.toFixed(1)} (max ${p.rss_max_mib.toFixed(1)}) MiB · footprint ${p.footprint_median_mib.toFixed(1)} (max ${p.footprint_max_mib.toFixed(1)}) MiB · cpu ${p.cpu_avg_pct.toFixed(2)}% · procs ${p.max_processes}`
    );
};

await main();
