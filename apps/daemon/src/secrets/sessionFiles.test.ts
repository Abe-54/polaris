import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionId, TurnItem } from "@polaris/protocol";
import { Effect, Predicate, Redacted, type Scope } from "effect";
import { expectPrivate } from "./privacy.testing.ts";
import { sessionSecretFiles } from "./sessionFiles.ts";

const S = SessionId.make("s1");

const VALUE = "tskey-auth-abc123";

const command = (output: string, input: { readonly args: ReadonlyArray<string> } | null = null) =>
  TurnItem.cases.ToolCall.make({
    id: "t1",
    startedAt: null,
    name: "Bash",
    input,
    output,
    status: "completed",
  });

const outputOf = (item: TurnItem) => (Predicate.isTagged(item, "ToolCall") ? item.output : null);

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program));

const root = () => mkdtempSync(join(tmpdir(), "session-secrets-"));

test("a secret is written owner-only, in an owner-only directory", async () => {
  const dir = root();

  const path = await run(
    Effect.gen(function* () {
      const files = yield* sessionSecretFiles(dir);
      const path = files.reserve(S);
      yield* files.write(S, path, Redacted.make(VALUE));

      return path;
    })
  );

  expect(readFileSync(path, "utf8")).toBe(VALUE);
  expectPrivate(path, "file");
  expectPrivate(dirname(path), "directory");
  expectPrivate(dir, "directory");
});

test("a secret is deleted when its time is up", async () => {
  const dir = root();

  const path = await run(
    Effect.gen(function* () {
      const files = yield* sessionSecretFiles(dir, { ttlMs: 20 });
      const path = files.reserve(S);
      yield* files.write(S, path, Redacted.make(VALUE));
      yield* Effect.sleep("80 millis");

      return path;
    })
  );

  expect(existsSync(path)).toBe(false);
});

test("on start, an expired secret is deleted and a live one is kept and still redacted", async () => {
  const dir = root();
  const segment = Buffer.from(S).toString("hex");
  mkdirSync(join(dir, segment), { recursive: true });
  const expired = join(dir, segment, "old");
  const live = join(dir, segment, "new");
  writeFileSync(expired, "expired-value", { mode: 0o600 });
  writeFileSync(live, VALUE, { mode: 0o600 });
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  utimesSync(expired, dayAgo, dayAgo);

  const redacted = await run(
    Effect.gen(function* () {
      const files = yield* sessionSecretFiles(dir);

      return outputOf(files.redact(command(`token=${VALUE}`)));
    })
  );

  expect(existsSync(expired)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(redacted).toBe("token=[secret]");
});

test("redaction replaces a live secret anywhere in any session's item", async () => {
  const dir = root();

  const [own, other] = await run(
    Effect.gen(function* () {
      const files = yield* sessionSecretFiles(dir);
      yield* files.write(S, files.reserve(S), Redacted.make(VALUE));
      const item = command(`key ${VALUE}\n`, { args: [VALUE, `"${VALUE}"`] });

      return [files.redact(item), files.redactText(`echo ${VALUE}`)] as const;
    })
  );

  expect(own).toEqual(command("key [secret]\n", { args: ["[secret]", '"[secret]"'] }));
  // Another session's agent could read the file too, so its output is redacted as well.
  expect(other).toBe("echo [secret]");
});

test("forgetting a session deletes its secrets and stops redacting them", async () => {
  const dir = root();

  const [path, after] = await run(
    Effect.gen(function* () {
      const files = yield* sessionSecretFiles(dir);
      const path = files.reserve(S);
      yield* files.write(S, path, Redacted.make(VALUE));
      yield* files.forget(S);

      return [path, outputOf(files.redact(command(VALUE)))] as const;
    })
  );

  expect(existsSync(path)).toBe(false);
  expect(after).toBe(VALUE);
});

test("a session id can't reach outside the store", async () => {
  const parent = root();
  const dir = join(parent, "store");
  const outside = join(parent, "keep");
  mkdirSync(outside);
  writeFileSync(join(outside, "file"), "kept");
  const hostile = SessionId.make("../keep");

  const path = await run(
    Effect.gen(function* () {
      const files = yield* sessionSecretFiles(dir);
      const path = files.reserve(hostile);
      yield* files.write(hostile, path, Redacted.make(VALUE));
      yield* files.forget(hostile);

      return path;
    })
  );

  expect(dirname(dirname(path))).toBe(dir);
  expect(readFileSync(join(outside, "file"), "utf8")).toBe("kept");
});
