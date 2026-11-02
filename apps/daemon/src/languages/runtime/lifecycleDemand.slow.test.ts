import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  LanguageDocumentNotification,
  LanguageRuntime,
  LanguageFeatureRequest,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { openFileWatchCount } from "../../files/watch.ts";
import { fixture } from "./fixtures.testing.ts";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }

  throw new Error("Lifecycle deadline");
}

async function closeDocument(
  f: Awaited<ReturnType<typeof fixture>>,
  client: string,
  context: Parameters<typeof f.broker.snapshot>[1]
) {
  return f.broker.sync(client, {
    context,
    sequence: 2,
    notification: LanguageDocumentNotification.cases.Close.make({ uri: f.uri, version: 1 }),
  });
}

test("idle waits for every Client, ignores held interests, and reopens retained context", async () => {
  const f = await fixture("ordinary", 30);

  try {
    const one = await f.acquire("one");
    const two = await f.acquire("two");
    await f.open("one", one.context);
    await f.open("two", two.context);
    await Promise.all([f.ready("one", one.context), f.ready("two", two.context)]);
    await closeDocument(f, "one", one.context);
    await Bun.sleep(60);
    expect(f.broker.stats().processes).toBe(2);
    await closeDocument(f, "two", two.context);
    await until(() => f.broker.stats().processSlots === 0);
    const reopened = await f.acquire("one");
    expect(reopened.runtime).toEqual(LanguageRuntime.cases.Stopped.make({ reason: "no-demand" }));
    await f.broker.sync("one", {
      context: reopened.context,
      sequence: 3,
      notification: LanguageDocumentNotification.cases.Open.make({
        uri: f.uri,
        languageId: "typescript",
        version: 2,
        text: "reopened draft",
      }),
    });
    await f.ready("one", reopened.context);
    expect(f.processes).toHaveLength(3);
  } finally {
    await f.dispose();
  }
});

test("reopening cancels the idle timer without replacing the process", async () => {
  const steps: Array<string> = [];
  const f = await fixture("ordinary", 5000, ({ event }) => void steps.push(event.type));

  try {
    const { context } = await f.acquire();
    await f.open("one", context);
    await f.ready("one", context);
    await closeDocument(f, "one", context);
    expect(steps.at(-1)).toBe("empty");
    await f.broker.sync("one", {
      context,
      sequence: 3,
      notification: LanguageDocumentNotification.cases.Open.make({
        uri: f.uri,
        languageId: "typescript",
        version: 2,
        text: "reopened",
      }),
    });
    // The idle timer is cleared at once, not left to find the demand when it fires.
    expect(steps.slice(-2)).toEqual(["empty", "demand"]);
    expect(f.processes).toHaveLength(1);
    expect(f.broker.stats().processes).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("three actual process kills stop retrying with stderr and manual restart retains drafts", async () => {
  const f = await fixture("stderr");

  try {
    const original = await f.acquire();
    await f.open("one", original.context, "unsaved crash draft");

    for (let i = 0; i < 3; i++) {
      await until(async () => Predicate.isTagged((await f.acquire()).runtime, "Ready"));
      const port = f.processes[i]!;
      process.kill(port.pid, "SIGKILL");
      await port.exited;
      await until(
        async () =>
          (await f.acquire()).context.generation > original.context.generation &&
          (i < 2
            ? f.processes.length > i + 1
            : Predicate.isTagged((await f.acquire()).runtime, "Stopped"))
      );
    }

    const stopped = await f.acquire();
    const stoppedRuntime = stopped.runtime;
    expect(Predicate.isTagged(stoppedRuntime, "Stopped")).toBe(true);

    if (!Predicate.isTagged(stoppedRuntime, "Stopped")) throw new Error("Missing stopped fact");
    expect(stoppedRuntime.reason).toBe("crash-budget");
    expect(stoppedRuntime.failure?.attempts).toBe(3);
    expect(stoppedRuntime.failure?.stderr).toContain("fixture stderr");
    expect(f.processes).toHaveLength(3);
    expect(stopped.ack.documents).toHaveLength(1);
    const restarted = await f.broker.restart("one", stopped.context);
    await f.ready("one", restarted.context);
    expect(
      (
        await f.broker.request(
          "one",
          LanguageFeatureRequest.make({
            requestId: "draft",
            fence: {
              context: restarted.context,
              requiredSequence: 1,
              documents: restarted.ack.documents,
            },
            method: "textDocument/hover",
            params: { textDocument: { uri: f.uri } },
            deadline: Date.now() + 2000,
          })
        )
      ).result
    ).toHaveProperty("text", "unsaved crash draft");
    process.kill(f.processes[3]!.pid, "SIGKILL");
    await until(() => f.processes.length === 5);
    const recoveredAgain = await f.acquire();
    await f.ready("one", recoveredAgain.context);
    expect(recoveredAgain.ack.documents).toEqual(restarted.ack.documents);
  } finally {
    await f.dispose();
  }
});

test("config bursts and atomic TypeScript replacement restart all Clients and resend unsaved text", async () => {
  const f = await fixture("ordinary", 30, undefined, undefined, undefined, false, {
    changeDebounceMs: 30,
    providerId: "typescript-language-server",
  });

  try {
    const one = await f.acquire("one");
    const two = await f.acquire("two");
    await f.open("one", one.context, "one draft");
    await f.open("two", two.context, "two draft");
    await Promise.all([f.ready("one", one.context), f.ready("two", two.context)]);
    await Bun.sleep(50);
    await mkdir(join(f.root, "nested"));
    await Bun.sleep(30);

    // Without yielding: a debounce firing between two awaited writes reads a middle state (ENG-343).
    for (let i = 0; i < 5; i++)
      writeFileSync(
        join(f.root, "nested/tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: i % 2 === 0 } })
      );
    await until(() => f.processes.length === 4);
    const changed = await f.acquire("one");
    const changedTwo = await f.acquire("two");
    await f.ready("one", changed.context);
    await f.ready("two", changedTwo.context);
    expect(changed.ack.acceptedSequence).toBe(1);
    expect(
      (
        await f.broker.request(
          "one",
          LanguageFeatureRequest.make({
            requestId: "changed",
            fence: {
              context: changed.context,
              requiredSequence: 1,
              documents: changed.ack.documents,
            },
            method: "textDocument/hover",
            params: { textDocument: { uri: f.uri } },
            deadline: Date.now() + 2000,
          })
        )
      ).result
    ).toHaveProperty("text", "one draft");
    await mkdir(join(f.root, "replacement/typescript"), { recursive: true });
    await writeFile(join(f.root, "replacement/typescript/package.json"), '{"version":"6.0.3"}');
    await rename(join(f.root, "replacement"), join(f.root, "node_modules"));
    await until(() => f.processes.length === 6);
    await Bun.sleep(100);
    expect(f.processes).toHaveLength(6);
  } finally {
    await f.dispose();
  }
});

test("a config event with unchanged content does not restart the server", async () => {
  const f = await fixture("ordinary", 30, undefined, undefined, undefined, false, {
    changeDebounceMs: 20,
    providerId: "typescript-language-server",
  });

  try {
    const original = await f.acquire();
    await f.open("one", original.context);
    await f.ready("one", original.context);
    await Bun.sleep(50);
    const config = join(f.root, "tsconfig.json");
    await writeFile(config, '{"compilerOptions":{"strict":true}}');
    await until(() => f.processes.length === 2);
    const restarted = await f.acquire();
    await f.ready("one", restarted.context);
    // The same bytes again, as macOS may report one write twice.
    await writeFile(config, '{"compilerOptions":{"strict":true}}');
    await Bun.sleep(200);
    expect((await f.acquire()).context).toEqual(restarted.context);
    await writeFile(config, '{"compilerOptions":{"strict":false}}');
    await until(() => f.processes.length === 3);
    await Bun.sleep(100);
    expect(f.processes).toHaveLength(3);
  } finally {
    await f.dispose();
  }
});

test("crashes outside the window do not accumulate and manual restart resets the new budget", async () => {
  const f = await fixture("ordinary", 30, undefined, undefined, undefined, false, {
    crashWindowMs: 40,
  });

  try {
    const original = await f.acquire();
    await f.open("one", original.context);

    for (let i = 0; i < 4; i++) {
      await until(async () => Predicate.isTagged((await f.acquire()).runtime, "Ready"));
      await Bun.sleep(50);
      process.kill(f.processes[i]!.pid, "SIGKILL");
      await until(() => f.processes.length > i + 1);
    }

    const current = await f.acquire();
    const restarted = await f.broker.restart("one", current.context);
    await f.ready("one", restarted.context);
    expect(f.processes).toHaveLength(6);
    expect(restarted.ack.documents).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("the last Client disconnect arms idle for a surviving empty Client context", async () => {
  const f = await fixture("ordinary", 30);

  try {
    const one = await f.acquire("one");
    const two = await f.acquire("two");
    await f.open("one", one.context);
    await f.open("two", two.context);
    await Promise.all([f.ready("one", one.context), f.ready("two", two.context)]);
    await closeDocument(f, "one", one.context);
    f.broker.disconnect("two");
    await until(() => f.broker.stats().processSlots === 0);
    expect((await f.acquire("one")).runtime).toEqual(
      LanguageRuntime.cases.Stopped.make({ reason: "no-demand" })
    );
  } finally {
    await f.dispose();
  }
});

test("a stopped retained context observes config changes before reopening and releases its watches", async () => {
  const before = openFileWatchCount();

  const f = await fixture("ordinary", 30, undefined, undefined, undefined, false, {
    providerId: "typescript-language-server",
    changeDebounceMs: 30,
  });

  try {
    const original = await f.acquire();
    await f.open("one", original.context);
    await f.ready("one", original.context);
    await closeDocument(f, "one", original.context);
    await until(() => f.broker.stats().processSlots === 0);
    const idle = await f.acquire();
    await writeFile(join(f.root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    await until(async () => (await f.acquire()).context.generation > idle.context.generation);
    const current = await f.acquire();
    expect(f.processes).toHaveLength(1);
    await f.broker.sync("one", {
      context: current.context,
      sequence: 3,
      notification: LanguageDocumentNotification.cases.Open.make({
        uri: f.uri,
        languageId: "typescript",
        version: 2,
        text: "reopened",
      }),
    });
    await f.ready("one", current.context);
    expect(f.processes).toHaveLength(2);
  } finally {
    await f.dispose();
  }

  expect(openFileWatchCount()).toBe(before);
});

test("closing during launch admission stops without consuming the crash budget", async () => {
  const gate = Promise.withResolvers<void>();

  const f = await fixture("ordinary", 1000, undefined, undefined, undefined, false, {
    reserveGate: gate.promise,
  });

  try {
    const original = await f.acquire();
    await f.open("one", original.context);
    await closeDocument(f, "one", original.context);
    gate.resolve();
    await until(async () => Predicate.isTagged((await f.acquire()).runtime, "Stopped"));
    const canceled = await f.acquire();
    expect(canceled.runtime).toEqual(LanguageRuntime.cases.Stopped.make({ reason: "no-demand" }));
    expect(f.processes).toHaveLength(0);
    await f.broker.sync("one", {
      context: canceled.context,
      sequence: 3,
      notification: LanguageDocumentNotification.cases.Open.make({
        uri: f.uri,
        languageId: "typescript",
        version: 2,
        text: "new demand",
      }),
    });
    await f.ready("one", canceled.context);
    const abort = new AbortController();
    const feed = f.broker.watch("one", canceled.context, abort.signal)[Symbol.asyncIterator]();
    process.kill(f.processes[0]!.pid, "SIGKILL");

    try {
      for (;;) {
        const next = await feed.next();

        if (next.done) throw new Error("Missing first crash fact");

        if (
          Predicate.isTagged(next.value, "RuntimeChanged") &&
          Predicate.isTagged(next.value.runtime, "Failed")
        ) {
          expect(next.value.runtime.attempts).toBe(1);
          break;
        }
      }
    } finally {
      abort.abort();
      await feed.return?.();
    }
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("a retrying process failure retains its typed reason and last stderr line", async () => {
  const f = await fixture("stderr");

  try {
    const { context } = await f.acquire();
    await f.open("one", context);
    await f.ready("one", context);
    await Bun.sleep(10);

    const events = f.broker
      .watch("one", context, new AbortController().signal)
      [Symbol.asyncIterator]();

    await events.next();
    void f.processes[0]!.stop();

    for (let n = 0; n < 20; n++) {
      const event = await events.next();

      if (event.done) throw new Error("No failed runtime");

      if (
        Predicate.isTagged(event.value, "Replaced") &&
        Predicate.isTagged(event.value.runtime, "Failed")
      ) {
        expect(event.value.runtime.failure).toEqual({
          reason: "server-failed",
          lastLogLine: "fixture stderr",
        });

        return;
      }
    }

    throw new Error("No retry failure observed");
  } finally {
    await f.dispose();
  }
});

test("crash-budget exhaustion retains the last server log when stderr is empty", async () => {
  const f = await fixture("log-only");

  try {
    const original = await f.acquire();
    await f.open("one", original.context);

    for (let i = 0; i < 3; i++) {
      await until(async () => Predicate.isTagged((await f.acquire()).runtime, "Ready"));
      const current = await f.acquire();
      const signal = new AbortController();
      const timeout = setTimeout(() => signal.abort(), 5000);
      let observed = false;

      try {
        for await (const event of f.broker.watchLog("one", current.context, signal.signal)) {
          const lines = Predicate.isTagged(event, "Snapshot") ? event.lines : [event.line];

          if (lines.some((line) => line.text === "private fixture show")) {
            observed = true;
            break;
          }
        }
      } finally {
        clearTimeout(timeout);
        signal.abort();
      }

      expect(observed).toBe(true);
      process.kill(f.processes[i]!.pid, "SIGKILL");
      await f.processes[i]!.exited;
      await until(async () =>
        i < 2
          ? f.processes.length > i + 1
          : Predicate.isTagged((await f.acquire()).runtime, "Stopped")
      );
    }

    const { runtime } = await f.acquire();
    expect(Predicate.isTagged(runtime, "Stopped")).toBe(true);

    if (!Predicate.isTagged(runtime, "Stopped")) throw new Error("Missing stopped runtime");
    expect(runtime.reason).toBe("crash-budget");
    expect(runtime.failure?.stderr).toBe("");
    expect(runtime.failure?.lastLogLine).toBe("private fixture show");
  } finally {
    await f.dispose();
  }
});
