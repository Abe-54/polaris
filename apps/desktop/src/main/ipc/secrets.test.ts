import { describe, expect, test } from "bun:test";
import type { HostConnection, LiveSession } from "@polaris/client";
import { RequestId, SECRET_MAX_BYTES, SessionId } from "@polaris/protocol";
import { Effect, Exit, Layer, Redacted, SubscriptionRef } from "effect";
import type { HostView } from "../../shared/api.ts";
import { HostDirectory, UnknownHost } from "../hosts.ts";
import { secretHandlers } from "./secrets.ts";

const sessionId = SessionId.make("s1");

const requestId = RequestId.make("r1");

/** One Host, "local", whose `secret.provide` records the value it was sent. */
const directory = (sent: Array<string>) => {
  const client = {
    "secret.provide": ({ value }: { readonly value: Redacted.Redacted<string> }) =>
      Effect.sync(() => void sent.push(Redacted.value(value))),
  };

  // SAFETY: the handler reads only `client` of the live session, and only `secret.provide`.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial fake of a generic RPC client
  const live = { client } as unknown as LiveSession;
  const connection: Partial<HostConnection> = { session: Effect.succeed(live) };

  return Layer.effect(
    HostDirectory,
    Effect.map(SubscriptionRef.make<ReadonlyArray<HostView>>([]), (views) =>
      HostDirectory.of({
        views,
        entry: () => undefined,
        connection: (key) =>
          key === "local"
            ? // SAFETY: the handler reads only `session` of a connection.
              Effect.succeed(connection as HostConnection)
            : Effect.fail(new UnknownHost(key)),
        add: () => Effect.void,
        remove: () => Effect.void,
      })
    )
  );
};

const provide = (value: string, sent: Array<string>, hostKey = "local") =>
  Effect.runPromiseExit(
    secretHandlers["secret.provide"]({ hostKey, sessionId, requestId, value }).pipe(
      Effect.provide(directory(sent))
    )
  );

describe("secret.provide in main", () => {
  test("a valid value reaches the Host trimmed", async () => {
    const sent: Array<string> = [];

    expect(Exit.isSuccess(await provide("  tskey-auth-123  ", sent))).toBe(true);
    expect(sent).toEqual(["tskey-auth-123"]);
  });

  test.each([
    ["   ", "Enter the secret"],
    ["line one\nline two", "Use a single line"],
    ["x".repeat(SECRET_MAX_BYTES + 1), "The secret is too long"],
  ])("a value the Host would refuse never leaves main (%#)", async (value, message) => {
    const sent: Array<string> = [];
    const exit = await provide(value, sent);

    expect(exit).toEqual(Exit.fail({ code: "InvalidInput", message }));
    expect(sent).toEqual([]);
  });

  test("an unknown Host fails without echoing the value", async () => {
    const exit = await provide("tskey-auth-123", [], "gone");

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("tskey-auth-123");
  });
});
