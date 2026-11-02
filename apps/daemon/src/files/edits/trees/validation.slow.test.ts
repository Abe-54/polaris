import { Match } from "effect";
import { expect } from "bun:test";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, expectFailure } from "./testing.ts";
import { snapshotTree, budget } from "./snapshot.ts";
import { fingerprint } from "../journal.ts";
import { identity, loadJournal } from "./journal.ts";
import { posixTest } from "../../../platform/testing.ts";

/** Tree edits identify entries by inode and check the journal's mode; Windows offers neither. */
const test = posixTest(
  "Windows bug: NTFS file IDs exceed a safe integer for LanguageResourceIdentity.inode (ENG-296), and the journal privacy check reads POSIX modes (ENG-314)"
);

for (const recursive of [false, true])
  test(`nonempty deletion recursive=${recursive}`, async () => {
    const f = await fixture();

    try {
      const r = await f.request(
        [{ kind: "delete", uri: f.uri("source"), options: { recursive } }],
        ["source"]
      );

      const o = await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
      expect(o.state).toBe(recursive ? "applied" : "failed");

      if (!recursive)
        expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
    } finally {
      await f.cleanup();
    }
  });

for (const kind of ["create", "rename"] as const)
  for (const options of [{}, { ignoreIfExists: true }, { ignoreIfExists: true, overwrite: true }])
    test(`${kind} existing directory ${JSON.stringify(options)}`, async () => {
      const f = await fixture();

      try {
        const operation =
          kind === "create"
            ? { kind, uri: f.uri("target"), options }
            : { kind, oldUri: f.uri("source"), newUri: f.uri("target"), options };

        const names = kind === "create" ? ["target"] : ["source", "target"];

        const r = await f.request([operation], names);
        const o = await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
        expect(o.state).toBe(options.ignoreIfExists ? "applied" : "failed");

        if (options.overwrite) {
          expect((await lstat(join(f.root, "target"))).isDirectory()).toBe(kind === "rename");
          expect(
            (await f.coordinator().recover(f.owner, "operation", o.receiptRevision, "undo")).state
          ).toBe("restored");
        }

        expect(await readFile(join(f.root, "target/original"), "utf8")).toBe("overwritten");
      } finally {
        await f.cleanup();
      }
    });

test("empty directory and absent ignore deletes, missing rename and self containment", async () => {
  for (const variant of ["empty", "absent", "rename", "contained"] as const) {
    const f = await fixture();

    try {
      await mkdir(join(f.root, "empty"));

      const operation = Match.value(variant).pipe(
        Match.when("rename", () => ({
          kind: "rename",
          oldUri: f.uri("absent"),
          newUri: f.uri("empty"),
        })),
        Match.when("contained", () => ({
          kind: "rename",
          oldUri: f.uri("source"),
          newUri: f.uri("source/new"),
        })),
        Match.orElse(() => ({
          kind: "delete",
          uri: f.uri(variant),
          options: { ignoreIfNotExists: true },
        }))
      );

      const names = Match.value(variant).pipe(
        Match.when("rename", () => ["absent", "empty"]),
        Match.when("contained", () => ["source", "source/new"]),
        Match.orElse(() => [variant])
      );

      const r = await f.request([operation], names);
      const o = await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
      expect(o.state).toBe(variant === "empty" || variant === "absent" ? "applied" : "failed");
    } finally {
      await f.cleanup();
    }
  }
});

test("authenticated acceptance and status/recovery hooks fail before changes", async () => {
  const f = await fixture();

  try {
    const r = await f.request(
      [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
      ["source", "final"]
    );

    const denied = f.coordinator({
      authorize: async () => {
        throw new Error("Unauthenticated");
      },
      authorizeRecovery: async () => {
        throw new Error("Unauthenticated");
      },
    });

    await expectFailure(
      denied.accept(f.owner, r.proposal, r.acceptance, r.drafts),
      "Unauthenticated"
    );
    await expectFailure(denied.get(f.owner, "operation"), "Unauthenticated");
    await expectFailure(denied.recover(f.owner, "operation", 1, "undo"), "Unauthenticated");
    expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
  } finally {
    await f.cleanup();
  }
});

test("exact preview, durable dirty descendant receipt and acceptance fence bind before mutation", async () => {
  const f = await fixture();

  try {
    const r = await f.request(
      [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
      ["source", "final"]
    );

    await expectFailure(
      f
        .coordinator()
        .accept(f.owner, r.proposal, { ...r.acceptance, resourceSnapshots: [] }, r.drafts),
      "Acceptance does not match"
    );
    await expectFailure(
      f.coordinator().accept(f.owner, r.proposal, r.acceptance, {
        ...r.drafts,
        previewFingerprint: "0".repeat(64),
      }),
      "Acceptance does not match"
    );

    const drafts = {
      ...r.drafts,
      descendants: [
        { canonicalPath: join(f.root, "source/nested/file"), draftRevision: 3, version: 7 },
      ],
    };

    const integration = f.coordinator({
      authorize: async (_owner, _proposal, _acceptance, receipt) => {
        if (!receipt || fingerprint(receipt.descendants) !== fingerprint(drafts.descendants))
          throw new Error("Incomplete durable Client drafts");
      },
    });

    await expectFailure(
      integration.accept(f.owner, r.proposal, r.acceptance, r.drafts),
      "Incomplete durable Client drafts"
    );
    const outcome = await integration.accept(f.owner, r.proposal, r.acceptance, drafts);
    expect(outcome.state).toBe("applied");
    expect(outcome.draftGroupId).toBe("draft-group");
  } finally {
    await f.cleanup();
  }
});

test("retry identity and receipt CAS reject stale decisions; identical retry never applies twice", async () => {
  const f = await fixture();

  try {
    const r = await f.request(
      [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
      ["source", "final"]
    );

    const c = f.coordinator();
    const o = await c.accept(f.owner, r.proposal, r.acceptance, r.drafts);
    expect(await c.accept(f.owner, r.proposal, r.acceptance, r.drafts)).toEqual(o);
    await expectFailure(
      c.accept(f.owner, { ...r.proposal, label: "changed" }, r.acceptance, r.drafts),
      "different acceptance"
    );
    await expectFailure(
      c.recover(f.owner, "operation", o.receiptRevision - 1, "undo"),
      "Receipt revision"
    );
    expect((await c.recover(f.owner, "operation", o.receiptRevision, "cancel")).state).toBe(
      "restored"
    );
  } finally {
    await f.cleanup();
  }
});

test("cancellation after intent and partial forward failure reverse only owned changes", async () => {
  for (const mode of ["cancel", "partial"] as const) {
    const f = await fixture();

    try {
      const r = await f.request(f.chain());
      const abort = new AbortController();

      const c = f.coordinator({
        fault: async (point, move) => {
          if (point === "intent" && move === 1) {
            if (mode === "cancel") abort.abort();
            else await writeFile(join(f.root, "target"), "external occupied absence");
          }
        },
      });

      const o = await c.accept(f.owner, r.proposal, r.acceptance, r.drafts, abort.signal);
      expect(o.state).toBe("partial");

      const recovered = await f
        .coordinator()
        .recover(f.owner, "operation", o.receiptRevision, "cancel");

      expect(recovered.state).toBe(mode === "cancel" ? "restored" : "recovery-required");

      if (mode === "partial")
        expect(await readFile(join(f.root, "target"), "utf8")).toBe("external occupied absence");
    } finally {
      await f.cleanup();
    }
  }
});

for (const change of ["root", "parent", "source", "destination"] as const)
  test(`replacement ${change} prevents stale snapshot mutation`, async () => {
    const f = await fixture();

    try {
      const r = await f.request(
        [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
        ["source", "final"]
      );

      if (change === "root") {
        await rename(f.root, `${f.root}-original`);
        await mkdir(f.root);
      }

      if (change === "parent") {
        await rename(join(f.root, "source/nested"), join(f.root, "source/old"));
        await mkdir(join(f.root, "source/nested"));
      }

      if (change === "source") {
        await rename(join(f.root, "source"), join(f.root, "old"));
        await mkdir(join(f.root, "source"));
      }

      if (change === "destination") await mkdir(join(f.root, "final"));
      const o = await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
      expect(o.state).toBe("failed");
    } finally {
      await f.cleanup();
    }
  });

test("snapshot enumeration root replacement and link race fail without following links", async () => {
  const f = await fixture();

  try {
    await expectFailure(
      snapshotTree(f.root, join(f.root, "source"), budget(), async (point, path) => {
        if (point === "directory-open" && path === join(f.root, "source/nested")) {
          await rename(path, `${path}-old`);
          await symlink(join(f.root, "target"), path);
        }
      }),
      "Directory replaced"
    );
    expect(await readFile(join(f.root, "target/original"), "utf8")).toBe("overwritten");
  } finally {
    await f.cleanup();
  }
});

test("entry/depth/hash-read limits and all encountered unsafe links fail closed", async () => {
  const f = await fixture();

  try {
    await expectFailure(
      snapshotTree(f.root, join(f.root, "source"), { entries: 4096, bytes: 0 }),
      "entry/depth"
    );
    await expectFailure(
      snapshotTree(f.root, join(f.root, "source"), { entries: 0, bytes: 67108864 }),
      "hash-read"
    );
    await symlink(join(f.root, "target"), join(f.root, "source/link"));
    await expectFailure(snapshotTree(f.root, join(f.root, "source")), "unsupported");
  } finally {
    await f.cleanup();
  }
});

test("raw journal read and ordered outcome expansion are bounded before any checkout mutation", async () => {
  const f = await fixture();

  try {
    const directory = join(f.home, "journal", `tree-${identity(f.owner, "oversized")}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "receipt.json"), " ".repeat(4194305));
    await expectFailure(loadJournal(directory), "raw read budget");
    const names = Array.from({ length: 20 }, (_, index) => `hop-${index}`);

    const operations = names.map((name, index) => ({
      kind: "rename",
      oldUri: f.uri(index === 0 ? "source" : names[index - 1]!),
      newUri: f.uri(name),
    }));

    // Full tree repeated in steps exceeds the wire receipt budget despite a bounded initial preview.
    for (let index = 0; index < 200; index++)
      await writeFile(join(f.root, "source", `large-${index}`), "bounded");
    const r = await f.request(operations, ["source", ...names]);
    const o = await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
    expect(o.state).toBe("failed");
    expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
    expect(await lstat(join(f.root, "hop-0")).catch(() => null)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test("canonical case aliases and URI dot traversal fail closed", async () => {
  const f = await fixture();

  try {
    const operations = [
      { kind: "rename", oldUri: `${f.uri("source")}/../source`, newUri: f.uri("final") },
    ];

    const r = await f.request(operations, ["source", "final"]);
    await expectFailure(
      f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts),
      "traversal"
    );
    const alias = await lstat(join(f.root, "SOURCE")).catch(() => null);

    if (alias) {
      const caseRequest = await f.request(
        [{ kind: "rename", oldUri: f.uri("SOURCE"), newUri: f.uri("final") }],
        ["source", "final"]
      );

      await expectFailure(
        f
          .coordinator()
          .accept(f.owner, caseRequest.proposal, caseRequest.acceptance, caseRequest.drafts),
        "alias"
      );
    }

    expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
  } finally {
    await f.cleanup();
  }
});

test("root replacement after applied receipt blocks restart undo", async () => {
  const f = await fixture();

  try {
    const r = await f.request(
      [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
      ["source", "final"]
    );

    const o = await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
    await rename(f.root, `${f.root}-old`);
    await mkdir(f.root);
    await expectFailure(
      f.coordinator().recover(f.owner, "operation", o.receiptRevision, "undo"),
      "Checkout identity changed"
    );
    expect(await readFile(join(`${f.root}-old`, "final/nested/file"), "utf8")).toBe("alpha\r\n");
  } finally {
    await f.cleanup();
  }
});

test("reject requires no Client draft group; accept cannot omit durable drafts", async () => {
  const f = await fixture();

  try {
    const r = await f.request(
      [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
      ["source", "final"]
    );

    await expectFailure(
      f.coordinator().accept(f.owner, r.proposal, r.acceptance, null),
      "Client drafts must be durable"
    );

    const outcome = await f
      .coordinator()
      .accept(f.owner, r.proposal, { ...r.acceptance, decision: "reject" }, null);

    expect(outcome.state).toBe("rejected");
    expect(outcome.draftGroupId).toBeNull();
    expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
  } finally {
    await f.cleanup();
  }
});

test("identical durable retry authenticates status after acceptance fences expire", async () => {
  const f = await fixture();

  try {
    const r = await f.request(
      [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
      ["source", "final"]
    );

    let fresh = true;
    let statusQueries = 0;

    const c = f.coordinator({
      authorize: async () => {
        if (!fresh) throw new Error("Fresh acceptance fence expired");
      },
      authorizeRecovery: async (_owner, _operation, intent) => {
        if (intent === "get") statusQueries++;
      },
    });

    const outcome = await c.accept(f.owner, r.proposal, r.acceptance, r.drafts);
    fresh = false;
    expect(await c.accept(f.owner, r.proposal, r.acceptance, r.drafts)).toEqual(outcome);
    expect(statusQueries).toBe(1);

    const denied = f.coordinator({
      authorizeRecovery: async () => {
        throw new Error("Foreign status owner");
      },
    });

    await expectFailure(
      denied.accept(f.owner, r.proposal, r.acceptance, r.drafts),
      "Foreign status owner"
    );
  } finally {
    await f.cleanup();
  }
});
