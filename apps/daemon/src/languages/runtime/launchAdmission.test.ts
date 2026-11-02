import assert from "node:assert/strict";
import { beforeAll, afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HostId,
  WorkspaceId,
  LanguageSyntaxId,
  LanguageCheckout,
  LanguageContextIdentity,
} from "@polaris/protocol";
import {
  createProjectDiscovery,
  effectiveSettings,
  type DiscoveryFacts,
} from "../discovery/index.ts";
import { LaunchAdmission, type LaunchSelectionLease } from "./launchAdmission.ts";
import type { ProcessPort } from "../transport/index.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;

  const promise = new Promise<A>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

let root = "";

let facts: DiscoveryFacts;

let context: LanguageContextIdentity;

beforeAll(async () => {
  root = newTempDir("m31-h1-launch-");
  await writeFile(join(root, "file.ts"), "saved");

  const checkout = LanguageCheckout.cases.Workspace.make({
    workspaceId: WorkspaceId.make("fake"),
    path: root,
  });

  const discovery = createProjectDiscovery({
    registry: async () => ({ checkout, workspacePath: root }),
  });

  facts = await discovery.discover({
    checkout,
    path: join(root, "file.ts"),
    providerId: "typescript-language-server",
    settings: effectiveSettings(
      {
        hostId: HostId.make("fake"),
        workspaceId: WorkspaceId.make("fake"),
        language: LanguageSyntaxId.make("typescript"),
      },
      [],
      0
    ),
  });
  context = LanguageContextIdentity.make({
    hostId: HostId.make("fake"),
    clientId: "one",
    contextId: "one",
    checkout,
    providerId: facts.providerId,
    projectRoot: facts.projectRoot,
    configurationFingerprint: facts.configurationFingerprint,
    generation: 1,
  });
});

afterAll(async () => {
  if (root !== "") await removeTempDirSettled(root);
});

function fixture() {
  let current = true;
  let released = 0;
  const admission = new LaunchAdmission(context, facts, () => current);

  const lease: LaunchSelectionLease = {
    selectionIdentity: "fake-selected-receipt",
    validate: async () => {},
    assertCurrent: () => {},
    release: async () => {
      released++;
    },
  };

  return {
    admission,
    lease,
    stale: () => {
      current = false;
    },
    released: () => released,
  };
}

function port(stop: () => Promise<void>, exited = Promise.resolve(0)): ProcessPort {
  return {
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    write: async () => {},
    stop,
    exited,
    pid: 0,
  };
}

test("absent admission rejects before resolution or spawn", async () => {
  const f = fixture();
  await assert.rejects(f.admission.acquire(), { reason: "audit-required" });
  expect(() => f.admission.spawn(() => port(async () => {}))).toThrow();
  await f.admission.releaseUnstarted();
  expect(f.released()).toBe(0);
});

test("late lease after cancellation is released once without spawning", async () => {
  const f = fixture();
  const held = deferred<LaunchSelectionLease>();

  const acquiring = assert.rejects(
    f.admission.acquire(() => held.promise),
    { reason: "stale-generation" }
  );

  f.admission.abort();
  const closing = f.admission.close();
  held.resolve(f.lease);
  await acquiring;
  await closing;
  await f.admission.releaseUnstarted();
  expect(f.released()).toBe(1);
  expect(() => f.admission.spawn(() => port(async () => {}))).toThrow();
});

test("generation and selection are synchronously fenced at native invocation", async () => {
  const f = fixture();
  await f.admission.acquire(async () => f.lease);
  f.stale();
  let invoked = false;
  expect(() =>
    f.admission.spawn(() => {
      invoked = true;

      return port(async () => {});
    })
  ).toThrow();
  expect(invoked).toBe(false);
  await f.admission.releaseUnstarted();
  const second = fixture();
  await second.admission.acquire(async () => second.lease);
  second.lease.assertCurrent = () => {
    throw new Error("Selection changed");
  };

  expect(() => second.admission.spawn(() => port(async () => {}))).toThrow("Selection changed");
  await second.admission.releaseUnstarted();
});

test("selection exclusion survives close completion until raw settlement", async () => {
  const f = fixture();
  await f.admission.acquire(async () => f.lease);
  f.admission.spawn(() => port(async () => {}));
  const raw = deferred<void>();
  f.admission.attach({ close: async () => {}, settlement: () => raw.promise });
  const closing = f.admission.close();
  await Promise.resolve();
  await f.admission.releaseUnstarted();
  expect(f.released()).toBe(0);
  raw.resolve();
  await closing;
  expect(f.released()).toBe(1);
});

test("failed close deadline retains selection even when raw settlement later succeeds", async () => {
  const f = fixture();
  await f.admission.acquire(async () => f.lease);
  f.admission.spawn(() => port(async () => {}));
  const raw = deferred<void>();
  f.admission.attach({
    close: async () => {
      throw new Error("Close deadline");
    },
    settlement: () => raw.promise,
  });
  await assert.rejects(f.admission.close(), /Close deadline/);
  raw.resolve();
  await f.admission.releaseUnstarted();
  expect(f.released()).toBe(0);
});

test("constructor failure retains lease through actual stop and process exit", async () => {
  const f = fixture();
  await f.admission.acquire(async () => f.lease);
  const exited = deferred<number>();
  f.admission.spawn(() => port(async () => {}, exited.promise));
  const closing = f.admission.close();
  await Promise.resolve();
  expect(f.released()).toBe(0);
  exited.resolve(0);
  await closing;
  expect(f.released()).toBe(1);
});

test("failed stop and failed release remain rejected ownership", async () => {
  const f = fixture();
  await f.admission.acquire(async () => f.lease);
  f.admission.spawn(() =>
    port(async () => {
      throw new Error("Stop rejected");
    })
  );
  await assert.rejects(f.admission.close(), /Stop rejected/);
  expect(f.released()).toBe(0);
  const second = fixture();
  await second.admission.acquire(async () => second.lease);
  second.lease.release = async () => {
    throw new Error("Release rejected");
  };

  await assert.rejects(second.admission.releaseUnstarted(), /Release rejected/);
  await assert.rejects(second.admission.close(), /Release rejected/);
});
