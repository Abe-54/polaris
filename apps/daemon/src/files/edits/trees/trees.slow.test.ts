import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { posixTest } from "../../../platform/testing.ts";
import { fixture } from "./testing.ts";

/** Tree edits identify entries by inode and check the journal's mode; Windows offers neither. */
const test = posixTest(
  "Windows bug: NTFS file IDs exceed a safe integer for LanguageResourceIdentity.inode (ENG-296), and the journal privacy check reads POSIX modes (ENG-314)"
);

test("ordered directory overwrite, rename and recursive deletion recover all trees", async () => {
  const f = await fixture();

  try {
    const { proposal, acceptance, drafts } = await f.request(f.chain());
    const outcome = await f.coordinator().accept(f.owner, proposal, acceptance, drafts);
    expect(outcome.state).toBe("applied");

    const restored = await f
      .coordinator()
      .recover(f.owner, "operation", outcome.receiptRevision, "undo");

    expect(restored.state).toBe("restored");
    expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
    expect(await readFile(join(f.root, "target/original"), "utf8")).toBe("overwritten");
  } finally {
    await f.cleanup();
  }
});

const restoredFiles = async (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
  expect(await readFile(join(f.root, "target/original"), "utf8")).toBe("overwritten");
};

for (const point of ["intent", "mutation", "receipt"] as const) {
  for (let move = 0; move < 4; move++) {
    test(`restart after ${point} directory move ${move}`, async () => {
      const f = await fixture();

      try {
        const request = await f.request(f.chain());

        const crashing = f.coordinator({
          fault: async (at, index) => {
            if (at === point && index === move) throw new InjectedCrash();
          },
        });

        expect(
          await crashing
            .accept(f.owner, request.proposal, request.acceptance, request.drafts)
            .catch((cause: unknown) => cause)
        ).toBeInstanceOf(InjectedCrash);
        const current = await f.coordinator().get(f.owner, "operation");

        const restored = await f
          .coordinator()
          .recover(f.owner, "operation", current!.receiptRevision, "recover");

        expect(restored.state).toBe("restored");
        await restoredFiles(f);
      } finally {
        await f.cleanup();
      }
    });
  }
}

for (const point of ["restore-intent", "restore-mutation"] as const) {
  for (let move = 0; move < 4; move++) {
    test(`restart during ${point} directory move ${move}`, async () => {
      const f = await fixture();

      try {
        const request = await f.request(f.chain());

        const outcome = await f
          .coordinator()
          .accept(f.owner, request.proposal, request.acceptance, request.drafts);

        const crashing = f.coordinator({
          fault: async (at, index) => {
            if (at === point && index === move) throw new InjectedCrash();
          },
        });

        expect(
          await crashing
            .recover(f.owner, "operation", outcome.receiptRevision, "undo")
            .catch((cause: unknown) => cause)
        ).toBeInstanceOf(InjectedCrash);
        const current = await f.coordinator().get(f.owner, "operation");

        const restored = await f
          .coordinator()
          .recover(f.owner, "operation", current!.receiptRevision, "recover");

        expect(restored.state).toBe("restored");
        await restoredFiles(f);
      } finally {
        await f.cleanup();
      }
    });
  }
}

import { InjectedCrash } from "./index.ts";
import { chmod, lstat, rm, symlink, writeFile } from "node:fs/promises";

for (const intervention of [
  "bytes",
  "addition",
  "deletion",
  "identity",
  "mode",
  "symlink",
] as const) {
  test(`undo preserves intervening descendant ${intervention}`, async () => {
    const f = await fixture();

    try {
      const request = await f.request(
        [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
        ["source", "final"]
      );

      const outcome = await f
        .coordinator()
        .accept(f.owner, request.proposal, request.acceptance, request.drafts);

      const path = join(f.root, "final/nested/file");

      if (intervention === "bytes") await writeFile(path, "external");

      if (intervention === "addition") await writeFile(join(f.root, "final/new"), "external");

      if (intervention === "deletion") await rm(path);

      if (intervention === "identity") {
        const bytes = await readFile(path);
        await rm(path);
        await writeFile(path, bytes);
      }

      if (intervention === "mode") await chmod(path, 0o400);

      if (intervention === "symlink") {
        await rm(path);
        await symlink(join(f.root, "target/original"), path);
      }

      const restored = await f
        .coordinator()
        .recover(f.owner, "operation", outcome.receiptRevision, "undo");

      expect(restored.state).toBe("recovery-required");
      expect((await lstat(join(f.root, "final"))).isDirectory()).toBe(true);
      expect(await lstat(join(f.root, "source")).catch(() => null)).toBeNull();

      if (intervention === "bytes") expect(await readFile(path, "utf8")).toBe("external");
    } finally {
      await f.cleanup();
    }
  });
}

test("overwrite backup descendant intervention blocks restoration and retains both trees", async () => {
  const f = await fixture();

  try {
    const request = await f.request(
      [
        {
          kind: "rename",
          oldUri: f.uri("source"),
          newUri: f.uri("target"),
          options: { overwrite: true },
        },
      ],
      ["source", "target"]
    );

    const outcome = await f
      .coordinator()
      .accept(f.owner, request.proposal, request.acceptance, request.drafts);

    const { identity } = await import("./journal.ts");

    const path = join(
      f.home,
      "journal",
      `tree-${identity(f.owner, "operation")}`,
      "backup-0/original"
    );

    await writeFile(path, "external backup");

    const restored = await f
      .coordinator()
      .recover(f.owner, "operation", outcome.receiptRevision, "undo");

    expect(restored.state).toBe("recovery-required");
    expect(await readFile(path, "utf8")).toBe("external backup");
    expect(await readFile(join(f.root, "source/nested/file"), "utf8")).toBe("alpha\r\n");
  } finally {
    await f.cleanup();
  }
});

test("ordered descendant edits after directory rename retain exact ownership and indexes", async () => {
  const f = await fixture();

  try {
    const operations = [
      { kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") },
      { textDocument: { uri: f.uri("final/nested/file"), version: 1 }, edits: [] },
      { kind: "rename", oldUri: f.uri("final/nested/file"), newUri: f.uri("final/new") },
      { kind: "delete", uri: f.uri("final"), options: { recursive: true } },
    ];

    const request = await f.request(operations, [
      "source",
      "final",
      "final/nested/file",
      "final/new",
    ]);

    const outcome = await f
      .coordinator()
      .accept(f.owner, request.proposal, request.acceptance, request.drafts);

    expect(outcome.state).toBe("applied");
    expect(outcome.steps.map((step) => step.index)).toEqual([0, 2, 3]);
    expect(
      (await f.coordinator().recover(f.owner, "operation", outcome.receiptRevision, "undo")).state
    ).toBe("restored");
    await restoredFiles(f);
  } finally {
    await f.cleanup();
  }
});

for (const point of ["prepared", "intent", "mutation", "receipt"] as const)
  test(`real SIGKILL directory restart at ${point}`, async () => {
    const f = await fixture();

    try {
      const r = await f.request(
        [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
        ["source", "final"]
      );

      const path = join(f.home, "request.json");
      await writeFile(
        path,
        JSON.stringify({ journalRoot: join(f.home, "journal"), owner: f.owner, ...r, point })
      );

      const child = Bun.spawn([process.execPath, join(import.meta.dir, "crash-worker.ts"), path], {
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(await child.exited).not.toBe(0);
      const current = (await f.coordinator().get(f.owner, "operation"))!;
      expect(current).not.toBeNull();
      expect(
        (await f.coordinator().recover(f.owner, "operation", current.receiptRevision, "recover"))
          .state
      ).toBe("restored");
      await restoredFiles(f);
    } finally {
      await f.cleanup();
    }
  });

for (const point of ["intent", "mutation", "receipt"] as const)
  for (let move = 0; move < 3; move++)
    test(`created file overwrites directory crash ${point} move ${move}`, async () => {
      const f = await fixture();

      try {
        const operations = [
          { kind: "create", uri: f.uri("target"), options: { overwrite: true } },
          { kind: "rename", oldUri: f.uri("target"), newUri: f.uri("final") },
        ];

        const r = await f.request(operations, ["target", "final"]);

        const c = f.coordinator({
          fault: async (at, index) => {
            if (at === point && index === move) throw new InjectedCrash();
          },
        });

        expect(
          await c
            .accept(f.owner, r.proposal, r.acceptance, r.drafts)
            .catch((cause: unknown) => cause)
        ).toBeInstanceOf(InjectedCrash);
        const current = (await f.coordinator().get(f.owner, "operation"))!;
        expect(
          (await f.coordinator().recover(f.owner, "operation", current.receiptRevision, "recover"))
            .state
        ).toBe("restored");
        await restoredFiles(f);
      } finally {
        await f.cleanup();
      }
    });
