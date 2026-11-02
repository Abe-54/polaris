import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { PairingId } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { Pairings, type PairingStoreError } from "./pairings.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const withStore = <A>(
  body: (pairings: Pairings["Service"], path: string) => Effect.Effect<A, PairingStoreError>
): Promise<A> => {
  const dir = newTempDir("pl-pairings-");
  const path = join(dir, "extensions.sqlite");

  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Pairings, (pairings) => body(pairings, path)).pipe(
        Effect.provide(Pairings.layer(path)),
        Effect.orDie
      )
    )
  ).finally(() => removeTempDirSettled(dir));
};

describe("Pairings", () => {
  test("a token opens its Pairing once paired, and nothing after revocation", async () => {
    const result = await withStore((pairings) =>
      Effect.gen(function* () {
        const { pairing, token } = yield* pairings.pair("Raycast", ["turn", "read", "read"]);
        const before = yield* pairings.authenticate(token);
        yield* pairings.touch(pairing.id);
        const revoked = yield* pairings.revoke(pairing.id);
        const after = yield* pairings.authenticate(token);
        const again = yield* pairings.revoke(pairing.id);
        const missing = yield* pairings.revoke(PairingId.make("pair_nope"));
        const listed = yield* pairings.list;

        return { pairing, token, before, revoked, after, again, missing, listed };
      })
    );

    expect(result.token).toMatch(/^pol_ext_[A-Za-z0-9_-]{43}$/);
    expect(result.pairing.grant).toEqual(["read", "turn"]);
    expect(Predicate.isTagged(result.before, "Valid") && result.before.pairing.id).toBe(
      result.pairing.id
    );
    expect(result.revoked?.revokedAt).not.toBeNull();
    expect(Predicate.isTagged(result.after, "Revoked")).toBe(true);
    expect(result.again?.revokedAt).toBe(result.revoked?.revokedAt ?? "");
    expect(result.missing).toBeNull();
    expect(result.listed).toHaveLength(1);
    expect(result.listed[0]?.lastUsedAt).not.toBeNull();
  });

  test("a malformed or never issued token is told apart from a revoked one", async () => {
    const result = await withStore((pairings) =>
      Effect.gen(function* () {
        yield* pairings.pair("Glasses", ["read"]);

        return {
          malformed: yield* pairings.authenticate("pol_ext_short"),
          foreign: yield* pairings.authenticate(`pol_ext_${"A".repeat(43)}`),
          hex: yield* pairings.authenticate("a".repeat(64)),
        };
      })
    );

    expect(Predicate.isTagged(result.malformed, "Malformed")).toBe(true);
    expect(Predicate.isTagged(result.foreign, "Unknown")).toBe(true);
    expect(Predicate.isTagged(result.hex, "Malformed")).toBe(true);
  });

  test("the file holds the token's hash only, and is private", async () => {
    const result = await withStore((pairings, path) =>
      Effect.map(pairings.pair("Raycast", ["read"]), ({ token }) => {
        const db = new Database(path, { readonly: true });
        const rows = db.query("SELECT hash FROM pairings").all();
        db.close();

        return { token, rows, mode: statSync(path).mode & 0o777 };
      })
    );

    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result.rows)).not.toContain(result.token.slice("pol_ext_".length));

    if (process.platform !== "win32") expect(result.mode).toBe(0o600);
  });
});
