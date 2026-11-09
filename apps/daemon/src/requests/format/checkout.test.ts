import { expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RequestsError } from "@polaris/protocol";
import { Result } from "effect";
import { tempDir } from "../../platform/tempDir.testing.ts";
import {
  MASK,
  fileVariables,
  formatCurl,
  loadSnapshot,
  parseDocument,
  resolveRequest,
  variableSources,
  type Resolution,
} from "./index.ts";

/** The Q1 ledger checkout as a git repository, with its gitignored `.env.local` and scratch file. */
const ledger = async (extra: Record<string, string> = {}) => {
  const root = tempDir("requests-format-");
  cpSync(join(import.meta.dir, "fixtures", "ledger"), root, { recursive: true });

  const files = {
    ".gitignore": ".env*\nscratch/\nhttp/http-client.private.env.json\n",
    ".env.local": "LEDGER_TOKEN=tok_live_51Hx9\nLEDGER_ADMIN_PASSWORD=hunter2\n",
    "scratch/local.http": "GET https://ignored.test/\n",
    "api/health.rest": "GET {{base}}/health\n",
    ...extra,
  };

  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }

  Bun.spawnSync(["git", "init", "-q"], { cwd: root });

  return root;
};

test("the snapshot lists request files that aren't gitignored, and every environment", async () => {
  const { snapshot } = await loadSnapshot(await ledger());

  expect(snapshot.files.map((file) => [file.path, file.requests.length])).toEqual([
    ["api/health.rest", 1],
    ["http/invoices.http", 5],
  ]);
  expect(snapshot.environments).toEqual(["dev", "staging", "prod"]);
});

/** Resolves the Q1 file's "Export overdue as CSV" in `environment`. */
const exportOverdue = async (
  root: string,
  environment: string | undefined
): Promise<Result.Result<Resolution, RequestsError>> => {
  const { documents } = await loadSnapshot(root);
  const document = documents.find((doc) => doc.file.path === "http/invoices.http")!;
  const request = document.file.requests[4]!;
  const sources = await variableSources(root, request.file, fileVariables(document), environment);

  if (Result.isFailure(sources)) return Result.fail(sources.failure);

  return resolveRequest(
    request,
    { ...sources.success, locality: (url) => (url.hostname === "localhost" ? "local" : "remote") },
    environment
  );
};

test("each variable source resolves: env, private env, file @vars and $dotenv, secrets masked", async () => {
  const root = await ledger();
  const dev = Result.getOrThrow(await exportOverdue(root, "dev"));
  const staging = Result.getOrThrow(await exportOverdue(root, "staging"));

  expect(dev.request.url).toBe(
    "http://localhost:4000/invoices/overdue.csv?tenant=acme&from=2026-10-01"
  );
  expect(dev.variables).toEqual([
    { name: "base", source: "env", masked: false, value: "http://localhost:4000", origin: "local" },
    { name: "tenant", source: "file", masked: false, value: "acme" },
    { name: "admin", source: "env", masked: false, value: "ops" },
    { name: "$dotenv LEDGER_ADMIN_PASSWORD", source: "dotenv", masked: true },
  ]);
  expect(staging.variables).toContainEqual({ name: "admin", source: "env", masked: true });
  expect(staging.variables[0]).toMatchObject({ origin: "remote" });

  const curl = formatCurl(staging.request, staging.secrets);
  expect(curl).toBe(
    `curl 'https://staging.ledger.example/invoices/overdue.csv?tenant=acme&from=2026-10-01' \\\n  -H 'Accept: text/csv' \\\n  -u '${MASK}:${MASK}'`
  );
  expect(curl).not.toContain("hunter2");
  expect(curl).not.toContain("staging-ops");
});

test("an environment in neither file is not found", async () => {
  const result = await exportOverdue(await ledger(), "qa");

  expect(Result.isFailure(result) && result.failure.code).toBe("E-ENVIRONMENT-NOT-FOUND");
});

test("a package's .env overrides the root's for $dotenv", async () => {
  const root = await ledger({ "http/.env": "LEDGER_ADMIN_PASSWORD=from-http-dir\n" });
  const document = parseDocument("GET /x\nX-P: {{$dotenv LEDGER_ADMIN_PASSWORD}}\n", "http/x.http");
  const sources = await variableSources(root, "http/x.http", {}, undefined);

  if (Result.isFailure(sources)) throw new Error(sources.failure.message);
  const resolved = resolveRequest(document.file.requests[0]!, sources.success);

  expect(Result.isSuccess(resolved) && resolved.success.request.headers[0]?.value).toBe(
    "from-http-dir"
  );
});
