/**
 * The partial handler layers of this workstream, mounted together under the
 * real `DaemonRpcs` tags and driven through an in-memory RPC client.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GitDiff, ReadFile, TerminalAttach, WorkspaceId } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { AttachmentRpcs, AttachmentRpcsLive } from "../attachments/AttachmentRpcs.ts";
import { AttachmentStoreLive } from "../attachments/AttachmentStore.ts";
import { GitRpcs, GitRpcsLive } from "../git/GitRpcs.ts";
import { makeRepo, removeTempDir, tempDir, write } from "../git/testing.ts";
import { TerminalRpcs, TerminalRpcsLive } from "../terminal/TerminalRpcs.ts";
import { EventStore } from "../store/EventStore.ts";
import { TerminalsLive } from "../terminal/Terminals.ts";
import { FileSearchLive } from "./FileSearch.ts";
import { FilesRpcs, FilesRpcsLive } from "./FilesRpcs.ts";
import { makeFakeBlobChannel } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const WorkspaceIoRpcs = FilesRpcs.merge(GitRpcs).merge(AttachmentRpcs).merge(TerminalRpcs);

describe("handler layers", () => {
  test("serve their DaemonRpcs tags end to end", async () => {
    const repo = await makeRepo({ "a.txt": "one\n" });
    const home = tempDir("polaris-home-");
    cleanup.push(repo, home);
    write(repo, "a.txt", "two\n");
    const blobs = makeFakeBlobChannel();
    const upload = blobs.put(new TextEncoder().encode("attached"));

    const handlers = Layer.mergeAll(
      FilesRpcsLive,
      GitRpcsLive,
      AttachmentRpcsLive,
      TerminalRpcsLive
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          FileSearchLive({ useFff: false }),
          TerminalsLive,
          EventStore.layerSqlite(":memory:"),
          AttachmentStoreLive({ root: join(home, "staging"), settingsPath: join(home, "s.json") }),
          blobs.layer
        )
      )
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(WorkspaceIoRpcs);

          const read = yield* client["files.read"]({
            path: join(repo, "a.txt"),
            offset: null,
            length: null,
          });

          const hits = yield* client["files.searchPaths"]({ root: repo, query: "a", limit: 5 });
          const status = yield* client["git.status"]({ cwd: repo });

          const diff = yield* client["git.diff"]({
            cwd: repo,
            spec: GitDiff.payloadSchema.fields.spec.cases.WorkingTree.make({ base: null }),
          });

          const shown = yield* client["git.show"]({ cwd: repo, revision: "HEAD", path: "a.txt" });

          const attachment = yield* client["attachments.stage"]({
            sessionId: null,
            workspaceId: WorkspaceId.make("ws"),
            name: "note.txt",
            mimeType: "text/plain",
            blobId: upload,
          });

          const { terminalId } = yield* client["terminal.open"]({
            cwd: repo,
            cols: 80,
            rows: 24,
            argv:
              process.platform === "win32"
                ? ["cmd.exe", "/d", "/c", "echo from-terminal"]
                : ["/bin/sh", "-c", "echo from-terminal"],
          });

          const output = yield* client["terminal.attach"]({ terminalId }).pipe(
            Stream.runCollect,
            Effect.timeout("5 seconds")
          );

          return { read, hits, status, diff, shown, attachment, output };
        }).pipe(Effect.provide(handlers))
      )
    );

    expect(result.read.content).toEqual(
      ReadFile.successSchema.fields.content.cases.Inline.make({ text: "two\n" })
    );
    expect(result.hits.map((h) => h.path)).toContain(join(repo, "a.txt"));
    expect(result.status.entries.map((e) => e.path)).toEqual(["a.txt"]);
    expect(new TextDecoder().decode(blobs.blobs.get(result.diff.blobId))).toContain("+two");
    expect(result.diff.fileIndex.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["a.txt", 1, 1],
    ]);
    // The committed content, not the working tree's.
    expect(result.shown.content).toEqual(
      ReadFile.successSchema.fields.content.cases.Inline.make({ text: "one\n" })
    );
    expect(result.attachment.name).toBe("note.txt");

    const Attached = TerminalAttach.successSchema.success;

    const text = result.output
      .map((item) => (Attached.guards.Output(item) ? new TextDecoder().decode(item.data) : ""))
      .join("");

    expect(text).toContain("from-terminal");
    expect(result.output.at(-1)).toEqual(Attached.cases.Exit.make({ code: 0 }));
  });
});
