import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LITELLM_URL } from "@polaris/client/usage";
import { Schema } from "effect";

const Seen = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ url: Schema.String, cache: Schema.NullOr(Schema.String) }))
);

const here = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

/**
 * Runs `body` in a child Bun with `electron` mocked: `net.fetch` records each request and
 * answers 503, and the global `fetch` throws. Prints what `net.fetch` saw.
 */
const throughElectron = (body: string) => {
  const userData = mkdtempSync(join(tmpdir(), "polaris-net-"));

  const source = `
    import { mock } from "bun:test";
    const seen = [];
    mock.module("electron", () => ({
      net: { fetch: async (url, init) => {
        seen.push({ url: String(url), cache: init?.cache ?? null });
        return new Response("{}", { status: 503 });
      } },
      app: { on: () => {} },
      BrowserWindow: { getFocusedWindow: () => null },
    }));
    globalThis.fetch = () => { throw new Error("global fetch used"); };
    const userData = ${JSON.stringify(userData)};
    ${body}
    console.log(JSON.stringify(seen));
  `;

  try {
    const child = Bun.spawnSync([process.execPath, "-e", source], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.stderr.toString()).toBe("");

    return Schema.decodeUnknownSync(Seen)(child.stdout.toString().trim().split("\n").at(-1));
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
};

test("GitHub sign-in goes through Electron's net.fetch, past Chromium's HTTP cache", () => {
  const seen = throughElectron(`
    const { Effect } = await import("effect");
    const { githubLayer } = await import(${here("./github/electron.ts")});
    const { GitHub } = await import(${here("./github/index.ts")});
    const { SecureStorage } = await import(${here("./secure/index.ts")});
    const { testSealer } = await import(${here("./secure/secure.testing.ts")});
    const secureStorage = SecureStorage.files({ dir: userData + "/secure", sealer: testSealer(), adopt: [] });
    await Effect.runPromise(
      GitHub.use((g) => Effect.exit(g.startSignIn())).pipe(
        Effect.provide(githubLayer({ userData, env: {}, secureStorage })),
        Effect.scoped
      )
    );
  `);

  expect(seen).toContainEqual({ url: "https://github.com/login/device/code", cache: "no-store" });
});

test("prices are fetched through Electron's net.fetch", () => {
  const seen = throughElectron(`
    const { openPrices } = await import(${here("./prices.ts")});
    await openPrices(userData).table();
  `);

  expect(seen.map((s) => s.url)).toContain(LITELLM_URL);
});
