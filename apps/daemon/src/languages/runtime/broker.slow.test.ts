import { expect, test } from "bun:test";
import { join } from "node:path";
import { Schema, Predicate } from "effect";
import {
  LanguageCheckout,
  ReviewCheckoutId,
  LanguageError,
  LanguageDocumentNotification,
  LanguageFeatureRequest,
  LanguageFeatureResult,
  LanguageSyncInput,
} from "@polaris/protocol";
import type { LanguageContextIdentity } from "@polaris/protocol";
import { fixture } from "./fixtures.testing.ts";

function hover(
  context: LanguageContextIdentity,
  uri: string,
  requestId = "hover",
  version = 1,
  sequence = 1,
  slow = false
) {
  return LanguageFeatureRequest.make({
    requestId,
    fence: { context, requiredSequence: sequence, documents: [{ uri, version }] },
    method: "textDocument/hover",
    params: { textDocument: { uri }, slow },
    deadline: Date.now() + 1000,
  });
}

test("demand-only startup, initialization configuration and typed ordered ack", async () => {
  const f = await fixture("slow-init");

  try {
    const { context } = await f.acquire();
    expect(f.processes).toHaveLength(0);
    const ack = await f.open("one", context);
    expect(ack.acceptedSequence).toBe(1);
    await f.broker.sync(
      "one",
      LanguageSyncInput.make({
        context,
        sequence: 2,
        notification: LanguageDocumentNotification.cases.Change.make({
          uri: f.uri,
          previousVersion: 1,
          version: 2,
          changes: [{ text: "new😀" }],
        }),
      })
    );
    await f.ready("one", context);
    const result = await f.broker.request("one", hover(context, f.uri, "hover", 2, 2));
    expect(Schema.is(LanguageFeatureResult)(result)).toBe(true);

    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        text: Schema.String,
        version: Schema.Int,
        received: Schema.Array(Schema.String),
        configuration: Schema.Array(Schema.Json),
      })
    )(result.result);

    expect(value.text).toBe("new😀");
    expect(value.version).toBe(2);
    expect(value.received.indexOf("initialized")).toBeLessThan(
      value.received.indexOf("textDocument/didOpen")
    );
    expect(value.received.filter((x) => x === "textDocument/didOpen")).toHaveLength(1);
    expect(value.configuration).toEqual(["configured", null]);
  } finally {
    await f.dispose();
  }

  expect(f.processes.every((port) => port.exited !== undefined)).toBe(true);
});

test("two Clients share installed executable but never draft content or context ownership", async () => {
  const f = await fixture();

  try {
    const first = await f.acquire("one");
    const second = await f.acquire("two");
    await Promise.all([
      f.open("one", first.context, "one private"),
      f.open("two", second.context, "two private"),
    ]);
    await Promise.all([f.ready("one", first.context), f.ready("two", second.context)]);
    const a = await f.broker.request("one", hover(first.context, f.uri));
    const b = await f.broker.request("two", hover(second.context, f.uri));
    expect(a.result).toHaveProperty("text", "one private");
    expect(b.result).toHaveProperty("text", "two private");
    await rejects(f.broker.request("two", hover(first.context, f.uri)), "not-owner");
    expect(f.processes).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

/** A fixture whose server stdin is watched: `sent(marker)` resolves once a frame containing it is written. */
async function watchedFixture() {
  const watchers: Array<{ marker: string; resolve: () => void }> = [];

  const f = await fixture("ordinary", 10, undefined, undefined, (port) => ({
    ...port,
    write: async (bytes) => {
      const text = new TextDecoder().decode(bytes);

      for (const watcher of watchers) if (text.includes(watcher.marker)) watcher.resolve();
      await port.write(bytes);
    },
  }));

  // Only frames written after the call count.
  const sent = (marker: string) => {
    const written = Promise.withResolvers<void>();
    watchers.push({ marker, resolve: written.resolve });

    return written.promise;
  };

  return { ...f, sent };
}

test("typing invalidates in-flight results; explicit cancel and stale queue cuts reject", async () => {
  const f = await watchedFixture();

  try {
    const { context } = await f.acquire();
    await f.open("one", context);
    await f.ready("one", context);
    const slowSent = f.sent("textDocument/hover");
    const pending = f.broker.request("one", hover(context, f.uri, "slow", 1, 1, true));

    const rejected = pending.then(
      () => "resolved",
      (error: LanguageError) => Schema.decodeUnknownSync(LanguageError)(error).reason
    );

    await slowSent;
    await f.broker.sync(
      "one",
      LanguageSyncInput.make({
        context,
        sequence: 2,
        notification: LanguageDocumentNotification.cases.Change.make({
          uri: f.uri,
          previousVersion: 1,
          version: 2,
          changes: [{ text: "changed" }],
        }),
      })
    );
    expect(await rejected).toBe("cancelled");
    await rejects(f.broker.request("one", hover(context, f.uri)), "stale-document");
    const cancelSent = f.sent("textDocument/hover");
    const cancellation = f.broker.request("one", hover(context, f.uri, "cancel", 2, 2, true));

    const cancelled = cancellation.then(
      () => "resolved",
      (error: LanguageError) => Schema.decodeUnknownSync(LanguageError)(error).reason
    );

    await cancelSent;
    f.broker.cancel("one", context, "cancel");
    expect(await cancelled).toBe("cancelled");
    const controller = new AbortController();
    controller.abort();
    await rejects(
      f.broker.request("one", hover(context, f.uri, "aborted", 2, 2), controller.signal),
      "cancelled"
    );
    await rejects(f.broker.request("one", hover(context, f.uri, "future", 2, 3)), "stale-document");
  } finally {
    await f.dispose();
  }
});

test("an explicit cancel reaches a request still waiting to be sent to the server", async () => {
  const f = await watchedFixture();

  try {
    const { context } = await f.acquire();
    await f.open("one", context);
    await f.ready("one", context);
    let sent = false;
    void f.sent("textDocument/hover").then(() => (sent = true));
    const queued = f.broker.request("one", hover(context, f.uri, "queued", 1, 1, true));
    f.broker.cancel("one", context, "queued");
    await rejects(queued, "cancelled");
    expect(sent).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("restart retains drafts while disconnect clears snapshots and generation-bound operations", async () => {
  const f = await fixture();

  try {
    const original = await f.acquire();
    await f.open("one", original.context);
    await f.ready("one", original.context);
    const restart = await f.broker.restart("one", original.context);
    expect(restart.context.generation).toBeGreaterThan(original.context.generation);
    expect(restart.ack.documents).toHaveLength(1);
    await rejects(f.broker.request("one", hover(original.context, f.uri)), "stale-generation");
    await f.ready("one", restart.context);
    expect((await f.broker.request("one", hover(restart.context, f.uri))).result).toHaveProperty(
      "text",
      "draft"
    );
    f.broker.disconnect("one");
    const reconnected = await f.acquire();
    expect(reconnected.context.generation).toBeGreaterThan(restart.context.generation);
    expect(reconnected.ack.acceptedSequence).toBe(0);
    await f.open("one", reconnected.context, "fresh");
    await f.ready("one", reconnected.context);
    expect(
      (await f.broker.request("one", hover(reconnected.context, f.uri))).result
    ).toHaveProperty("text", "fresh");
  } finally {
    await f.dispose();
  }
});

test("open documents retain process across view release; last close cleans process after grace", async () => {
  const f = await fixture();

  try {
    const { context } = await f.acquire();
    await f.open("one", context);
    await f.ready("one", context);
    await f.broker.release("one", context, "file");
    await Bun.sleep(20);
    expect(f.broker.stats().processes).toBe(1);
    await f.broker.sync(
      "one",
      LanguageSyncInput.make({
        context,
        sequence: 2,
        notification: LanguageDocumentNotification.cases.Close.make({ uri: f.uri, version: 1 }),
      })
    );

    for (let i = 0; i < 100 && (f.broker.stats().cleanup > 0 || f.broker.stats().contexts > 0); i++)
      await Bun.sleep(10);
    expect(f.broker.stats().contexts).toBe(0);
    expect(f.broker.stats().cleanup).toBe(0);
    expect(await f.processes[0]!.exited).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("trust revocation fences long-lived generations and prevents any untrusted spawn", async () => {
  const f = await fixture();

  try {
    const { context } = await f.acquire();
    f.revoke();
    await rejects(f.open("one", context), "stale-generation");
    expect(f.processes).toHaveLength(0);
    const next = await f.acquire();
    await rejects(f.open("one", next.context), "awaiting-trust");
    f.grant();
    const trusted = await f.acquire();
    await f.open("one", trusted.context);
    await f.ready("one", trusted.context);
    f.revoke();
    await rejects(f.broker.request("one", hover(trusted.context, f.uri)), "stale-generation");
  } finally {
    await f.dispose();
  }
});

async function rejects(operation: Promise<unknown>, reason: string) {
  const outcome = await operation.then(
    () => "resolved",
    (error: LanguageError) => Schema.decodeUnknownSync(LanguageError)(error).reason
  );

  expect(outcome).toBe(reason);
}

test("one Client uses separate processes and drafts for Workspace and Worktree", async () => {
  const f = await fixture();

  try {
    const workspace = await f.acquire();
    const worktreeUri = new URL("file.ts", new URL(`file://${f.worktreeRoot}/`)).href;

    const worktree = await f.broker.acquire("one", {
      clientId: "one",
      contextId: "worktree",
      interestId: "file",
      checkout: f.worktree,
      path: `${f.worktreeRoot}/file.ts`,
      providerId: "fake",
      settings: f.settings,
    });

    await f.open("one", workspace.context, "workspace draft");
    await f.broker.sync(
      "one",
      LanguageSyncInput.make({
        context: worktree.context,
        sequence: 1,
        notification: LanguageDocumentNotification.cases.Open.make({
          uri: worktreeUri,
          languageId: "typescript",
          version: 1,
          text: "worktree draft",
        }),
      })
    );
    await Promise.all([f.ready("one", workspace.context), f.ready("one", worktree.context)]);
    expect((await f.broker.request("one", hover(workspace.context, f.uri))).result).toHaveProperty(
      "text",
      "workspace draft"
    );
    expect(
      (await f.broker.request("one", hover(worktree.context, worktreeUri))).result
    ).toHaveProperty("text", "worktree draft");
    expect(f.processes).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("malformed actual server output invalidates generation and cleans child", async () => {
  const f = await fixture("malformed");

  try {
    const original = await f.acquire();
    await f.open("one", original.context);
    let current = await f.acquire();

    for (let i = 0; i < 200 && current.context.generation === original.context.generation; i++) {
      await Bun.sleep(5);
      current = await f.acquire();
    }

    expect(current.context.generation).toBeGreaterThan(original.context.generation);
    expect(current.ack.documents).toHaveLength(1);

    for (let i = 0; i < 200 && !Predicate.isTagged((await f.acquire()).runtime, "Stopped"); i++)
      await Bun.sleep(5);
    expect((await f.acquire()).runtime).toHaveProperty("reason", "crash-budget");
    expect(f.broker.stats().processes).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("grace cleanup waits for every Client and preserves a newly acquired context", async () => {
  const f = await fixture("slow-shutdown");

  try {
    const first = await f.acquire("one");
    const second = await f.acquire("two");
    await f.open("one", first.context);
    await f.open("two", second.context, "other Client");
    await f.ready("one", first.context);
    await f.ready("two", second.context);
    await f.broker.release("one", first.context, "file");
    await f.broker.sync(
      "one",
      LanguageSyncInput.make({
        context: first.context,
        sequence: 2,
        notification: LanguageDocumentNotification.cases.Close.make({ uri: f.uri, version: 1 }),
      })
    );

    await Bun.sleep(30);
    expect(f.broker.stats().contexts).toBe(2);
    await f.broker.sync("two", {
      context: second.context,
      sequence: 2,
      notification: LanguageDocumentNotification.cases.Close.make({ uri: f.uri, version: 1 }),
    });
    await f.broker.release("two", second.context, "file");

    for (let i = 0; i < 100 && f.broker.stats().contexts > 0; i++) await Bun.sleep(5);
    expect(f.broker.stats().contexts).toBe(0);
    const replacement = await f.acquire("one");
    expect(replacement.context.generation).toBeGreaterThan(first.context.generation);
    await f.open("one", replacement.context, "replacement");
    await f.ready("one", replacement.context);
    expect(await f.processes[0]!.exited).toBe(0);
    expect(f.broker.snapshot("one", replacement.context).ack.documents).toHaveLength(1);
    await rejects(f.broker.request("two", hover(second.context, f.uri)), "stale-generation");
  } finally {
    await f.dispose();
  }
});

test("disconnect fences in-flight discovery without cancelling another Client", async () => {
  let release: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const f = await fixture("ordinary", 10, undefined, gate);

  try {
    const lost = rejects(f.acquire("one"), "not-connected");
    const other = f.acquire("two");
    f.broker.disconnect("one");
    release?.();
    await lost;
    expect((await other).context.clientId).toBe("two");
    expect(f.broker.stats().contexts).toBe(1);
    expect(f.broker.stats().acquiring).toBe(0);
  } finally {
    release?.();
    await f.dispose();
  }
});

test("checkout and Workspace restarts preserve edited drafts and isolate another Client", async () => {
  const f = await fixture();

  try {
    const one = await f.acquire("one");
    const two = await f.acquire("two");
    await f.open("one", one.context, "one unsaved");
    await f.open("two", two.context, "two unsaved");
    await f.ready("one", one.context);
    await f.ready("two", two.context);

    const changed = await f.broker.sync("one", {
      context: one.context,
      sequence: 2,
      notification: LanguageDocumentNotification.cases.Change.make({
        uri: f.uri,
        previousVersion: 1,
        version: 2,
        changes: [{ text: "latest unsaved" }],
      }),
    });

    const restarted = await f.broker.restartMatching(
      "one",
      one.context.checkout,
      one.context.checkout.workspaceId,
      "fake"
    );

    expect(restarted).toHaveLength(1);
    const current = restarted[0]!;
    expect(current.ack.documents).toEqual(changed.documents);
    expect(current.ack.acceptedSequence).toBe(2);
    await f.ready("one", current.context);
    expect(
      (await f.broker.request("one", hover(current.context, f.uri, "latest", 2, 2))).result
    ).toHaveProperty("text", "latest unsaved");
    expect(f.broker.snapshot("two", two.context).context).toEqual(two.context);
    expect(
      await f.broker.restartMatching(
        "one",
        one.context.checkout,
        one.context.checkout.workspaceId,
        "absent"
      )
    ).toEqual([]);
    const all = await f.broker.restartMatching("one", null, one.context.checkout.workspaceId);
    expect(all).toHaveLength(1);
    await rejects(
      f.broker.request("one", hover(current.context, f.uri, "stale", 2, 2)),
      "stale-generation"
    );
    expect((await f.broker.request("two", hover(two.context, f.uri))).result).toHaveProperty(
      "text",
      "two unsaved"
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace interpreter selection restarts both Clients' basedpyright drafts and preserves Ruff", async () => {
  const f = await fixture("ordinary", 10, undefined, undefined, undefined, false, {
    providerId: "basedpyright",
  });

  try {
    const one = await f.acquire("one");
    const two = await f.acquire("two");

    const ruff = await f.broker.acquire("one", {
      clientId: "one",
      contextId: "lint",
      checkout: f.checkout,
      path: join(f.root, "file.ts"),
      providerId: "ruff",
      settings: f.settings,
      interestId: "file",
    });

    await f.open("one", one.context, "one private draft");
    await f.open("two", two.context, "two private draft");
    await f.open("one", ruff.context, "lint draft");
    await Promise.all([
      f.ready("one", one.context),
      f.ready("two", two.context),
      f.ready("one", ruff.context),
    ]);

    const restarted = await f.broker.restartMatching(
      null,
      null,
      f.checkout.workspaceId,
      "basedpyright"
    );

    expect(restarted).toHaveLength(2);

    for (const current of restarted) {
      const client = current.context.clientId;
      const text = client === "one" ? "one private draft" : "two private draft";

      expect(current.ack.documents).toEqual([{ uri: f.uri, version: 1 }]);
      expect(current.ack.acceptedSequence).toBe(1);
      await f.ready(client, current.context);
      expect((await f.broker.request(client, hover(current.context, f.uri))).result).toHaveProperty(
        "text",
        text
      );
    }

    expect(f.broker.snapshot("one", ruff.context).context).toEqual(ruff.context);
  } finally {
    await f.dispose();
  }
});

test("selection-scoped restarts include Worktrees and isolate Review Checkouts", async () => {
  const f = await fixture();

  try {
    const workspace = await f.acquire("one");

    const reviewCheckout = LanguageCheckout.cases.ReviewCheckout.make({
      workspaceId: f.checkout.workspaceId,
      reviewCheckoutId: ReviewCheckoutId.make("review"),
      path: f.root,
    });

    const acquire = (checkout: LanguageCheckout, contextId: string) =>
      f.broker.acquire("one", {
        clientId: "one",
        contextId,
        checkout,
        path: join(checkout.path, "file.ts"),
        providerId: "fake",
        settings: f.settings,
        interestId: "file",
      });

    const worktree = await acquire(f.worktree, "tree");
    const review = await acquire(reviewCheckout, "review");

    const restarted = await f.broker.restartMatching(
      null,
      null,
      f.checkout.workspaceId,
      "fake",
      f.checkout
    );

    expect(restarted).toHaveLength(2);
    expect(restarted.map((x) => x.context.contextId)).toEqual([
      workspace.context.contextId,
      worktree.context.contextId,
    ]);
    expect(restarted[0]!.context.generation).toBeGreaterThan(workspace.context.generation);
    expect(restarted[1]!.context.generation).toBeGreaterThan(worktree.context.generation);
    expect(f.broker.snapshot("one", review.context).context).toEqual(review.context);

    const reviewRestart = await f.broker.restartMatching(
      null,
      null,
      f.checkout.workspaceId,
      "fake",
      reviewCheckout
    );

    expect(reviewRestart).toHaveLength(1);
    expect(reviewRestart[0]?.context.checkout).toEqual(reviewCheckout);
  } finally {
    await f.dispose();
  }
});
