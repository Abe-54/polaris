// A stand-in OTLP receiver: same path shape and refusals as the Daemon's receiver, decoding with the
// Daemon's own decodeBatch (redaction included) so the output is what Polaris would store.
// Usage: bun collector.ts <outdir>   (prints the port to <outdir>/port, appends to <outdir>/*.jsonl)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBatch } from "../../../../apps/daemon/src/traces/decoder.ts";

const out = process.argv[2] ?? "/tmp/rpu-p7/out";
mkdirSync(out, { recursive: true });

const context = {
  checkout: "/tmp/rpu-p7",
  workspaceId: "ws_review",
  sessionId: null,
  turns: [],
} as never;

// Like the Daemon's receiver (receiver.ts): at most one request in flight per token, else 429.
const inFlight = new Set<string>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const type = req.headers.get("content-type") ?? "";
    const enc = req.headers.get("content-encoding") ?? "";
    const token = url.pathname.split("/")[2] ?? "";
    if (inFlight.has(token)) {
      appendFileSync(join(out, "requests.log"), `${new Date().toISOString()} ${req.method} ${url.pathname} -> 429 (token busy)\n`);
      return new Response("busy", { status: 429 });
    }
    inFlight.add(token);
    try {
      return await handle(req, url, type, enc);
    } finally {
      inFlight.delete(token);
    }
  },
});

async function handle(req: Request, url: URL, type: string, enc: string): Promise<Response> {
    const body = new Uint8Array(await req.arrayBuffer());
    // The Daemon's worker decodes and queues before answering; this delay stands in for it.
    await Bun.sleep(Number(process.env.COLLECTOR_DELAY_MS ?? 0));
    appendFileSync(
      join(out, "requests.log"),
      `${new Date().toISOString()} ${req.method} ${url.pathname} type=${type} enc=${enc} bytes=${body.length}\n`
    );
    const m = /^\/otlp\/[A-Za-z0-9_-]+\/v1\/(traces|logs)$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    if (enc) return new Response("compression refused", { status: 415 });
    const signal = m[1] as "traces" | "logs";
    try {
      const batch = decodeBatch(body, signal, type.split(";")[0]!.trim(), context);
      for (const s of batch.spans) appendFileSync(join(out, "spans.jsonl"), JSON.stringify(s) + "\n");
      for (const l of batch.logs) appendFileSync(join(out, "logs.jsonl"), JSON.stringify(l) + "\n");
    } catch (error) {
      appendFileSync(join(out, "requests.log"), `  decode failed: ${String(error)}\n`);
      return new Response("bad", { status: 400 });
    }
    return type.includes("json") ? Response.json({}) : new Response(new Uint8Array(), {
      headers: { "content-type": "application/x-protobuf" },
    });
}

writeFileSync(join(out, "port"), String(server.port));
console.log(`collector on ${server.port}`);
