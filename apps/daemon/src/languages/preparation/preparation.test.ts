import { test, expect } from "bun:test";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageCheckout, LanguageTreeEditProposal } from "@polaris/protocol";
import { Schema } from "effect";
import { makeProposalPreparation } from "./index.ts";
import { HostDelivery, type PreparationPort } from "./contracts.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const fileIdentity = posixTest(
  "Windows bug: NTFS file IDs exceed a safe integer, which LanguageResourceIdentity.inode rejects (ENG-296)"
);

const edit = [
  { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "λ" },
];

const fixture = async (run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) => {
  const f = await setup();

  try {
    await run(f);
  } finally {
    await removeTempDirSettled(f.root);
  }
};

const setup = async () => {
  const root = newTempDir("m31-host-preparation-");
  await writeFile(join(root, "a"), "a😀b\r\n");
  const uri = pathToFileURL(join(root, "a")).href;

  let delivery = Schema.decodeUnknownSync(HostDelivery)({
    edit: { changes: { [uri]: edit } },
    fence: {
      context: {
        hostId: "00000000-0000-4000-8000-000000000001",
        clientId: "client",
        contextId: "context",
        checkout: LanguageCheckout.cases.Workspace.make({
          workspaceId: Schema.decodeUnknownSync(
            LanguageCheckout.cases.Workspace.fields.workspaceId
          )("00000000-0000-4000-8000-000000000002"),
          path: root,
        }),
        projectRoot: root,
        providerId: "provider",
        generation: 1,
        configurationFingerprint: "a".repeat(64),
      },
      requiredSequence: 0,
      documents: [],
    },
    origin: "rename",
    label: "Rename",
    encoding: "utf-16",
  });

  let current = delivery.fence.context;
  let checks = 0;
  let observe = async (_checks: number) => {};

  const port: PreparationPort = {
    delivery: async (id) => {
      if (id !== "delivered") throw new Error("Unknown Host delivery");

      return delivery;
    },
    validate: async (_id, captured) => {
      await observe(++checks);

      if (JSON.stringify(current) !== JSON.stringify(captured.fence.context))
        throw new Error("Stale authenticated authority");

      if (JSON.stringify(delivery) !== JSON.stringify(captured))
        throw new Error("Changed Host provenance");
    },
    document: () => Promise.resolve(null),
  };

  return {
    root,
    uri,
    port,
    read: () => makeProposalPreparation(port).read("delivered"),
    set: (next: HostDelivery) => {
      delivery = next;
    },
    get: () => delivery,
    observe: (next: typeof observe) => {
      observe = next;
    },
    replaceAuthority: () => {
      current = { ...current, generation: current.generation + 1 };
    },
  };
};

const rejected = async (result: Promise<unknown>, message: string) => {
  let error = "";

  try {
    await result;
  } catch (cause) {
    error = String(cause);
  }

  expect(error).toContain(message);
};

fileIdentity(
  "Host-issued text proposal reads canonical version/text and preserves UTF16/CRLF",
  () =>
    fixture(async (f) => {
      const { proposal, documents } = await f.read();
      expect(proposal.snapshots[0]?.diskText).toBe("a😀b\r\n");
      expect(proposal.snapshots[0]?.diskVersion?.size).toBe(8);
      expect(proposal.snapshots[0]?.buffer).toBeNull();
      expect(proposal.proposalId).not.toBe("delivered");
      expect(proposal.expiresAt).toBeGreaterThan(Date.now());
      expect(documents).toEqual([]);
    })
);

test("opaque delivery lookup refuses fabricated renderer reference", () =>
  fixture(async (f) => {
    await rejected(makeProposalPreparation(f.port).read("forged"), "Unknown Host delivery");
  }));

fileIdentity("late independent authority replacement and filesystem change refuse proposal", () =>
  fixture(async (f) => {
    f.observe(async (count) => {
      if (count === 3) f.replaceAuthority();
    });
    await rejected(f.read(), "Stale authenticated authority");
  })
);

fileIdentity("file replacement between initial snapshot and final read refuses newer work", () =>
  fixture(async (f) => {
    f.observe(async (count) => {
      if (count === 3) await writeFile(join(f.root, "a"), "newer Agent work");
    });
    await rejected(f.read(), "Resource changed");
  })
);

fileIdentity("outside checkout and unsafe link targets are refused", () =>
  fixture(async (f) => {
    f.set({
      ...f.get(),
      edit: { changes: { [pathToFileURL(join(f.root, "..", "outside")).href]: edit } },
    });
    await rejected(f.read(), "escapes checkout");
    await symlink(join(f.root, "a"), join(f.root, "alias"));
    f.set({ ...f.get(), edit: { changes: { [pathToFileURL(join(f.root, "alias")).href]: edit } } });
    await rejected(f.read(), "link");
  })
);

fileIdentity(
  "ordered create rename delete owns complete source and overwritten trees plus absence",
  () =>
    fixture(async (f) => {
      await mkdir(join(f.root, "source"));
      await writeFile(join(f.root, "source", "child"), "source");
      await mkdir(join(f.root, "target"));
      await writeFile(join(f.root, "target", "child"), "overwritten");
      const uri = (name: string) => pathToFileURL(join(f.root, name)).href;

      const changes = [
        { kind: "create" as const, uri: uri("created") },
        {
          kind: "rename" as const,
          oldUri: uri("source"),
          newUri: uri("target"),
          options: { overwrite: true },
        },
        { kind: "delete" as const, uri: uri("created") },
      ];

      f.set({ ...f.get(), edit: { documentChanges: changes } });
      const { proposal } = await f.read();
      expect(proposal.edit.documentChanges).toEqual(changes);
      expect("format" in proposal && proposal.format).toBe(2);

      const treeProposal = Schema.decodeUnknownSync(LanguageTreeEditProposal)(proposal);
      expect(
        treeProposal.resourceSnapshots.find((snapshot) => snapshot.uri === uri("created"))?.tree
      ).toBeNull();
      expect(
        treeProposal.resourceSnapshots.find((snapshot) => snapshot.uri === uri("source"))?.tree
          ?.entries.length
      ).toBe(2);
      expect(
        treeProposal.resourceSnapshots.find((snapshot) => snapshot.uri === uri("target"))?.tree
          ?.entries.length
      ).toBe(2);
    })
);

fileIdentity("occupied absence and partial unsupported inventory fail closed", () =>
  fixture(async (f) => {
    const uri = pathToFileURL(join(f.root, "created")).href;
    f.set({ ...f.get(), edit: { documentChanges: [{ kind: "create", uri }] } });
    f.observe(async (count) => {
      if (count === 3) await writeFile(join(f.root, "created"), "external");
    });
    await rejected(f.read(), "Resource changed");
    f.observe(async () => {});
    await mkdir(join(f.root, "tree"));
    await symlink(join(f.root, "a"), join(f.root, "tree", "unsafe"));
    f.set({
      ...f.get(),
      edit: {
        documentChanges: [{ kind: "delete", uri: pathToFileURL(join(f.root, "tree")).href }],
      },
    });
    await rejected(f.read(), "unsupported link");
  })
);

fileIdentity("versioned edits require exact Host fence and surrogate/overlap limits", () =>
  fixture(async (f) => {
    f.set({
      ...f.get(),
      edit: { documentChanges: [{ textDocument: { uri: f.uri, version: 9 }, edits: edit }] },
    });
    await rejected(f.read(), "captured Host document fence");
    f.set({
      ...f.get(),
      edit: {
        changes: {
          [f.uri]: [
            {
              ...edit[0]!,
              range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
            },
          ],
        },
      },
    });
    await rejected(f.read(), "splits encoded character");
    f.set({ ...f.get(), edit: { changes: { [f.uri]: [...edit, ...edit] } } });
    await rejected(f.read(), "overlap");
  })
);

fileIdentity("oversize text and cancelled preparation produce no proposal", () =>
  fixture(async (f) => {
    await writeFile(join(f.root, "a"), "x".repeat(1048577));
    await rejected(f.read(), "bounded regular file");
    const controller = new AbortController();
    controller.abort();
    await rejected(
      makeProposalPreparation(f.port).read("delivered", controller.signal),
      "cancelled"
    );
  })
);

fileIdentity("acknowledged Host mirror requires independent Client draft revision proof", () =>
  fixture(async (f) => {
    const base = f.get();
    f.set({ ...base, fence: { ...base.fence, documents: [{ uri: f.uri, version: 9 }] } });
    const document = { version: 9, text: "a😀b\r\n" };
    const port: PreparationPort = { ...f.port, document: () => Promise.resolve(document) };

    await rejected(
      makeProposalPreparation(port).read("delivered"),
      "acknowledgment is unavailable"
    );

    const acknowledged = {
      ...port,
      acknowledgedBuffer: () => Promise.resolve({ uri: f.uri, ...document, draftRevision: 27 }),
    };

    const { proposal } = await makeProposalPreparation(acknowledged).read("delivered");
    expect(proposal.snapshots[0]?.buffer).toEqual({ ...document, draftRevision: 27 });

    const wrong = {
      ...port,
      acknowledgedBuffer: () =>
        Promise.resolve({ uri: f.uri, version: 8, text: document.text, draftRevision: 27 }),
    };

    await rejected(makeProposalPreparation(wrong).read("delivered"), "differs from Host document");

    const wrongUri = {
      ...port,
      acknowledgedBuffer: () =>
        Promise.resolve({
          uri: pathToFileURL(join(f.root, "b")).href,
          ...document,
          draftRevision: 27,
        }),
    };

    await rejected(
      makeProposalPreparation(wrongUri).read("delivered"),
      "differs from Host document"
    );
  })
);

fileIdentity(
  "late acknowledgment revision change refuses issuance rather than refreshing accepted snapshots",
  () =>
    fixture(async (f) => {
      const base = f.get();
      f.set({ ...base, fence: { ...base.fence, documents: [{ uri: f.uri, version: 9 }] } });
      let revision = 27;

      const port: PreparationPort = {
        ...f.port,
        document: () => Promise.resolve({ version: 9, text: "a😀b\r\n" }),
        acknowledgedBuffer: () =>
          Promise.resolve({ uri: f.uri, version: 9, text: "a😀b\r\n", draftRevision: revision++ }),
      };

      await rejected(makeProposalPreparation(port).read("delivered"), "acknowledgment changed");
    })
);

fileIdentity("absent text after ordered create stays null in Host initial snapshot", () =>
  fixture(async (f) => {
    const uri = pathToFileURL(join(f.root, "new")).href;

    const insert = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "new text",
      },
    ];

    const changes = [
      { kind: "create" as const, uri },
      { textDocument: { uri, version: null }, edits: insert },
    ];

    f.set({ ...f.get(), edit: { documentChanges: changes } });
    const { proposal } = await f.read();
    expect(proposal.snapshots[0]?.diskText).toBeNull();
    expect(proposal.snapshots[0]?.diskVersion).toBeNull();
    expect(proposal.edit.documentChanges).toEqual(changes);
  })
);

test("Host provenance replacement and resource path overflow are refused", () =>
  fixture(async (f) => {
    f.observe(async (count) => {
      if (count === 1) f.set({ ...f.get(), label: "Replaced delivery" });
    });
    await rejected(f.read(), "Changed Host provenance");
    f.observe(async () => {});
    f.set({
      ...f.get(),
      edit: {
        documentChanges: Array.from({ length: 129 }, (_, index) => ({
          kind: "create",
          uri: pathToFileURL(join(f.root, String(index))).href,
        })),
      },
    });
    await rejected(f.read(), "Resource path budget");
  }));

fileIdentity("invalid UTF8 and binary disk bytes cannot become text snapshots", () =>
  fixture(async (f) => {
    await writeFile(join(f.root, "a"), Buffer.from([0xff, 0x61]));
    await rejected(f.read(), "ERR_ENCODING_INVALID_ENCODED_DATA");
    await writeFile(join(f.root, "a"), Buffer.from([0x61, 0]));
    await rejected(f.read(), "Binary text");
  })
);

fileIdentity("proposal aggregate encoded size fails rather than truncating closed texts", () =>
  fixture(async (f) => {
    await writeFile(join(f.root, "a"), "x".repeat(600000));
    await writeFile(join(f.root, "b"), "x".repeat(600000));
    const b = pathToFileURL(join(f.root, "b")).href;
    f.set({ ...f.get(), edit: { changes: { [f.uri]: [], [b]: [] } } });
    await rejected(f.read(), "encoded budget");
  })
);

fileIdentity("closed snapshot refuses a mirror appearing during filesystem waits", () =>
  fixture(async (f) => {
    let reads = 0;

    const port: PreparationPort = {
      ...f.port,
      document: () => Promise.resolve(++reads === 1 ? null : { version: 0, text: "new open work" }),
    };

    await rejected(makeProposalPreparation(port).read("delivered"), "differs from captured fence");
  })
);
