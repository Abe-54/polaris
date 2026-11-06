import { expect, test } from "bun:test";
import * as P from "@polaris/protocol";
import { Predicate } from "effect";
import { coordinatorFixture } from "./coordinator.testing.ts";
import { languageStore } from "./state.ts";

const fixture = coordinatorFixture;

test("second preview joins the live context with only didClose/didOpen, becomes ready and receives diagnostics", async () => {
  const f = fixture();

  try {
    const a = f.open("a.ts");
    await f.settled(a);
    const context = a.entry()?.features.options.providers()[0]?.context;
    a.lifetime.dispose();
    const start = f.requests.length;
    const b = f.open("b.ts");
    await f.settled(b);
    expect(f.requests.slice(start)).toEqual(["languages.document.sync", "languages.document.sync"]);
    expect(b.entry()?.features.options.providers()[0]?.context).toEqual(context);
    expect(languageStore.getState().files[b.key]?.status).toBe("ready");
    f.service.diagnose("file:///reuse/b.ts");
    expect(b.entry()?.diagnostics.values()).toHaveLength(1);
    expect(f.service.releases).toBe(0);
  } finally {
    f.coordinator.dispose();
  }

  expect(f.service.releases).toBe(1);
});

test("a replaced context invalidates discovery before the next file opens", async () => {
  const f = fixture();

  try {
    const a = f.open("a.ts");
    await f.settled(a);
    f.replace(a);
    await f.settled(a);
    const start = f.requests.length;
    const b = f.open("b.ts");
    await f.settled(b);
    expect(
      f.requests.slice(start).filter((method) => method === "languages.discover")
    ).toHaveLength(1);
    expect(b.entry()?.features.options.providers()[0]?.context.generation).toBe(2);
  } finally {
    f.coordinator.dispose();
  }
});

test("provider override refreshes Settings and discovery, while nested directories discover independently", async () => {
  const f = fixture();

  try {
    const a = f.open("a.ts");
    await f.settled(a);
    const start = f.requests.length;
    f.override();
    await f.settled(a);
    expect(
      f.requests.slice(start).filter((method) => method === "languages.discover")
    ).toHaveLength(1);
    expect(
      a.entry()?.groups[0]?.acquisition.settings.settings.executableOverrides?.fixture?.executable
    ).toBe("/reuse/tool");
    const beforeNested = f.requests.length;
    const nested = f.open("nested/b.ts");
    await f.settled(nested);
    expect(
      f.requests.slice(beforeNested).filter((method) => method === "languages.discover")
    ).toHaveLength(1);
  } finally {
    f.coordinator.dispose();
  }
});

test("authenticated connection replacement retires retained contexts and re-observes", async () => {
  const f = fixture();

  try {
    const a = f.open("a.ts");
    await f.settled(a);
    const context = a.entry()?.features.options.providers()[0]?.context;
    f.reconnect();
    await f.settled(a);
    expect(f.service.releases).toBe(1);
    expect(a.entry()?.features.options.providers()[0]?.context.contextId).not.toBe(
      context?.contextId
    );
    expect(f.requests.filter((method) => method === "languages.discover")).toHaveLength(2);
  } finally {
    f.coordinator.dispose();
  }
});

test("a file opened while a Trust change replaces the context still reaches ready", async () => {
  const f = fixture();

  try {
    const a = f.open("a.ts");
    await f.settled(a);
    const release = f.holdDiscovery();
    // Another directory, so b discovers afresh rather than sharing a's observation.
    const b = f.open("nested/b.ts");

    // The replacement lands while b's discovery is in flight, as a Trust change does.
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.replace(a, P.LanguageRuntime.cases.Ready.make({ capabilities: f.service.capabilities }));
    release();
    await f.settled(b);
    expect(languageStore.getState().files[b.key]?.status).toBe("ready");
  } finally {
    f.coordinator.dispose();
  }
});

test("a file joining a context whose server stopped for lack of demand opens it, which starts it", async () => {
  const f = fixture();

  try {
    const a = f.open("a.ts");
    await f.settled(a);
    // The last file closes; the Daemon replaces the context with a stopped server.
    f.service.acquired = P.LanguageRuntime.cases.Stopped.make({ reason: "no-demand" });
    const provider = f.providerOf(a);
    a.lifetime.dispose();
    f.replace(provider, P.LanguageRuntime.cases.Stopped.make({ reason: "no-demand" }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    f.open("b.ts");

    for (let count = 0; count < 100; count++) {
      if (f.service.notifications.some((n) => n.uri === "file:///reuse/b.ts")) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(
      f.service.notifications.some(
        (n) => Predicate.isTagged(n, "Open") && n.uri === "file:///reuse/b.ts"
      )
    ).toBe(true);
  } finally {
    f.coordinator.dispose();
  }
});

test("SQL files retain separate contexts for their per-file dialect configuration", async () => {
  const f = fixture("select 1;");

  try {
    const a = f.open("a.sql");
    await f.settled(a);
    const b = f.open("b.sql");
    await f.settled(b);
    expect(f.providerOf(b)?.context.contextId).not.toBe(f.providerOf(a)?.context.contextId);
    expect(f.requests.filter((method) => method === "languages.discover")).toHaveLength(2);
  } finally {
    f.coordinator.dispose();
  }
});
