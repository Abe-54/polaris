/**
 * Model-based test of Pairings and Grants (ENG-398): random sequences of pair,
 * revoke, authenticate and gate decisions against the real SQLite `Pairings`
 * store and `decideAccess`, checked after every step against a reference
 * model (the `extensions` module of `packages/spec/extensions.qnt`):
 *
 *   - a token opens exactly its Pairing until that Pairing is revoked, and a
 *     token never issued, or malformed, opens nothing;
 *   - a connection scoped to a Pairing is refused exactly what its Grant
 *     lacks, with the missing Grant named, and everything kept for Clients;
 *   - a token-less connection is never refused.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Command,
  COMMAND_GRANTS,
  decideAccess,
  GRANT_KINDS,
  type GrantKind,
  type Pairing,
  RPC_GRANTS,
} from "@polaris/protocol";
import { Effect, Match } from "effect";
import fc from "fast-check";
import { Pairings, type TokenCheck } from "../extensions/pairings.ts";
import { pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

const RUNS = pbtRuns(40);

const rpcTags = Object.keys(RPC_GRANTS);

const commandTags = Object.keys(COMMAND_GRANTS);

const grantArb = fc.uniqueArray(fc.constantFrom(...GRANT_KINDS), { maxLength: 5 });

const Op = fc.oneof(
  fc.record({
    op: fc.constant("pair" as const),
    name: fc.constantFrom("Raycast", "G2"),
    grant: grantArb,
  }),
  fc.record({ op: fc.constant("revoke" as const), which: fc.nat(3) }),
  fc.record({ op: fc.constant("authenticate" as const), which: fc.nat(3) }),
  fc.record({ op: fc.constant("authenticateForeign" as const) }),
  fc.record({
    op: fc.constant("rpc" as const),
    which: fc.nat(3),
    rpc: fc.constantFrom(...rpcTags, "voice.transcribe"),
  }),
  fc.record({
    op: fc.constant("command" as const),
    which: fc.nat(3),
    command: fc.constantFrom(...commandTags),
    permissionMode: fc.constantFrom("supervised", "auto", "full-access"),
  })
);

type Op = typeof Op extends fc.Arbitrary<infer A> ? A : never;

/** The reference: each issued token's Pairing and whether it was revoked. */
interface Issued {
  readonly token: string;
  readonly pairing: Pairing;
  revoked: boolean;
}

/** What the gate must answer, from the mapping and the Pairing's Grant alone. */
const expectedRefusal = (
  grant: ReadonlyArray<GrantKind> | null,
  what: string,
  access: string,
  alsoApproves = false
): { what: string; needed: GrantKind | null } | null => {
  if (grant === null || access === "open") return null;

  if (access === "client") return { what, needed: null };
  // SAFETY: every non-open, non-client entry of the mappings is a Grant kind.
  const needed = access as GrantKind;

  if (!grant.includes(needed)) return { what, needed };

  return alsoApproves && !grant.includes("approve") ? { what, needed: "approve" } : null;
};

const tokenCheckOf = (check: TokenCheck) =>
  Match.value(check).pipe(
    Match.tags({
      Valid: ({ pairing }) => ({ kind: "valid" as const, id: pairing.id }),
      Revoked: ({ pairing }) => ({ kind: "revoked" as const, id: pairing.id }),
      Malformed: () => ({ kind: "malformed" as const, id: null }),
      Unknown: () => ({ kind: "unknown" as const, id: null }),
    }),
    Match.exhaustive
  );

const refusalOf = (refusal: ReturnType<typeof decideAccess>) =>
  refusal === null ? null : { what: refusal.what, needed: refusal.needed };

/** The store, the Pairings it issued, and the connection under test. */
interface World {
  readonly pairings: Pairings["Service"];
  readonly issued: Array<Issued>;
  /** The connection under test: token-less, or scoped to an issued Pairing. */
  readonly scopeOf: (which: number) => Issued | null;
}

const pairOp = (world: World, op: Extract<Op, { op: "pair" }>) =>
  Effect.map(world.pairings.pair(op.name, op.grant), (made) => {
    world.issued.push({ token: made.token, pairing: made.pairing, revoked: false });
  });

const revokeOp = (world: World, op: Extract<Op, { op: "revoke" }>) =>
  Effect.gen(function* () {
    const target = world.scopeOf(op.which);

    if (target === null) return;
    const revoked = yield* world.pairings.revoke(target.pairing.id);
    target.revoked = true;
    expect(revoked?.revokedAt).not.toBeNull();
  });

const authenticateOp = (world: World, op: Extract<Op, { op: "authenticate" }>) =>
  Effect.gen(function* () {
    const target = world.scopeOf(op.which);

    if (target === null) return;
    const check = tokenCheckOf(yield* world.pairings.authenticate(target.token));
    expect(check).toEqual({ kind: target.revoked ? "revoked" : "valid", id: target.pairing.id });
  });

const authenticateForeignOp = (world: World) =>
  Effect.gen(function* () {
    const foreign = `pol_ext_${"Z".repeat(43)}`;
    expect(tokenCheckOf(yield* world.pairings.authenticate(foreign)).kind).toBe("unknown");
    expect(tokenCheckOf(yield* world.pairings.authenticate("pol_ext_")).kind).toBe("malformed");
  });

const rpcOp = (world: World, op: Extract<Op, { op: "rpc" }>) =>
  Effect.sync(() => {
    const target = world.scopeOf(op.which);
    const grant = target === null ? null : target.pairing.grant;

    const access = Object.hasOwn(RPC_GRANTS, op.rpc)
      ? // SAFETY: `hasOwn` proved `op.rpc` is a key of RPC_GRANTS.
        RPC_GRANTS[op.rpc as keyof typeof RPC_GRANTS]
      : "client";

    // `dispatch` is decided per Command; one without a Command is refused, as a client-only call.
    const expected =
      op.rpc === "dispatch"
        ? expectedRefusal(grant, "dispatch:", "client")
        : expectedRefusal(grant, op.rpc, access);

    expect(refusalOf(decideAccess(target?.pairing ?? null, op.rpc, null))).toEqual(expected);
  });

const commandOp = (world: World, op: Extract<Op, { op: "command" }>) =>
  Effect.sync(() => {
    const target = world.scopeOf(op.which);
    const grant = target === null ? null : target.pairing.grant;
    // SAFETY: `op.command` is drawn from COMMAND_GRANTS' keys.
    const access = COMMAND_GRANTS[op.command as Command["_tag"]];

    const refusal = decideAccess(
      target?.pairing ?? null,
      "dispatch",
      op.command,
      op.permissionMode
    );

    // An unsupervised session approves for itself: starting one is approving too.
    const alsoApproves = op.command === "StartSession" && op.permissionMode !== "supervised";

    expect(refusalOf(refusal)).toEqual(
      expectedRefusal(grant, `dispatch:${op.command}`, access, alsoApproves)
    );
  });

const applyOp = (world: World, op: Op) =>
  Match.value(op).pipe(
    Match.when({ op: "pair" }, (o) => pairOp(world, o)),
    Match.when({ op: "revoke" }, (o) => revokeOp(world, o)),
    Match.when({ op: "authenticate" }, (o) => authenticateOp(world, o)),
    Match.when({ op: "authenticateForeign" }, () => authenticateForeignOp(world)),
    Match.when({ op: "rpc" }, (o) => rpcOp(world, o)),
    Match.when({ op: "command" }, (o) => commandOp(world, o)),
    Match.exhaustive
  );

const runOps = (ops: ReadonlyArray<Op>) =>
  Effect.gen(function* () {
    const pairings = yield* Pairings;
    const issued: Array<Issued> = [];

    const world: World = {
      pairings,
      issued,
      scopeOf: (which) => issued[which % (issued.length + 1)] ?? null,
    };

    for (const op of ops) yield* applyOp(world, op);

    // The store agrees with the reference at the end: every Pairing, revoked or not.
    const listed = yield* pairings.list;
    expect(listed.map((p) => [p.id, p.revokedAt !== null])).toEqual(
      issued.map((i) => [i.pairing.id, i.revoked])
    );
  });

describe("Pairings and Grants (model-based)", () => {
  test(
    "tokens, revocation and the Grant gate agree with the reference model",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(Op, { minLength: 1, maxLength: 40 }), async (ops) => {
          const dir = mkdtempSync(join(tmpdir(), "pl-ext-model-"));

          try {
            await Effect.runPromise(
              Effect.scoped(
                runOps(ops).pipe(Effect.provide(Pairings.layer(join(dir, "extensions.sqlite"))))
              )
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: RUNS, ...pbtSeed() }
      );
    },
    pbtTimeout(RUNS, 500)
  );
});
