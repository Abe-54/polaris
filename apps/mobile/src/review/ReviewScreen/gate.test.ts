import { describe, expect, test } from "bun:test";
import type { ConnectionState } from "@polaris/protocol";
import { reviewGate } from "./gate.ts";

const host = (state: ConnectionState, failure: string | null = null) => ({
  name: "lucas-rpi",
  state,
  failure,
});

const loading = { kind: "loading" } as const;

describe("a Review before its Turn is known", () => {
  test("loads while a connected Host sends the session", () => {
    expect(reviewGate({ host: host("connected"), session: loading })).toEqual({ kind: "loading" });
  });

  test.each([
    ["reconnecting", "Can't reach lucas-rpi", true, true],
    ["offline", "lucas-rpi is offline", false, true],
    ["needs-attention", "lucas-rpi needs attention", false, false],
  ] as const)(
    "names the Host while it is %s, never an empty Turn 0",
    (state, title, reconnecting, retry) => {
      expect(reviewGate({ host: host(state), session: loading })).toEqual({
        kind: "away",
        title,
        line: "This turn's review opens as soon as it connects.",
        failure: null,
        reconnecting,
        retry,
      });
    }
  );

  test("shows the Host's own failure when it gave one", () => {
    const gate = reviewGate({ host: host("offline", "ssh: connection refused"), session: loading });

    expect(gate.kind === "away" && gate.failure).toBe("ssh: connection refused");
  });

  test("a session already read stays on screen while the Host is away", () => {
    expect(
      reviewGate({ host: host("reconnecting"), session: { kind: "ready", turnFound: true } })
    ).toEqual({
      kind: "ready",
    });
  });

  test("says why there is nothing to review: an unlinked Host, a missing Turn, a failed read", () => {
    expect(reviewGate({ host: null, session: loading })).toEqual({
      kind: "missing",
      title: "This host isn't linked to this iPhone",
      failure: null,
    });
    expect(
      reviewGate({ host: host("connected"), session: { kind: "ready", turnFound: false } })
    ).toEqual({
      kind: "missing",
      title: "This turn isn't on lucas-rpi",
      failure: null,
    });
    expect(
      reviewGate({
        host: host("connected"),
        session: { kind: "failed", message: "This agent session isn't on the host" },
      })
    ).toEqual({
      kind: "missing",
      title: "Can't open this review",
      failure: "This agent session isn't on the host",
    });
  });
});
