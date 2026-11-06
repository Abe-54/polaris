import { expect, test } from "bun:test";
import * as P from "@polaris/protocol";
import { SaveCoordinator, type FormatSnapshot, type SaveReason } from "./index.ts";
import { formattedText } from "./edits.ts";

// Every save path (⌘S, :w/:wq, close, quit, Save All) saves as "manual" does; only autosave differs.
const SAVE_REASONS = ["manual", "autosave"] satisfies SaveReason[];

const provider = P.LanguageFormatterSelection.cases.Provider.make({ providerId: "fixture" });

const deferred = <A>() => {
  let finish: (value: A) => void = () => undefined;

  const promise = new Promise<A>((resolve) => {
    finish = resolve;
  });

  return { promise, finish: (value: A) => finish(value) };
};

const fixture = (format: (snapshot: FormatSnapshot, signal: AbortSignal) => Promise<string>) => {
  let text = "const n=1";
  let version = 1;
  let alive = true;
  let disk = "";
  let writes = 0;
  let diskOk = true;
  let enabled = true;
  let selected: P.LanguageFormatterSelection = provider;
  let serverFormats = true;
  let applies = 0;

  const notices: string[] = [];
  const reasons: SaveReason[] = [];

  const coordinator = new SaveCoordinator(
    {
      snapshot: (reason) => ({
        file: { hostKey: "fake", workspaceId: "ws_fixture", path: "/fixture/a.ts" },
        text,
        version,
        diskVersion: null,
        reason,
      }),
      current: (snapshot) => alive && snapshot.version === version,
      apply: (next) => {
        applies++;
        text = next;

        version++;
      },
      write: async () => {
        writes++;
        disk = text;

        return alive && diskOk;
      },
    },
    {
      settings: async () => ({ formatOnSave: enabled, formatter: selected }),
      format: (snapshot, _formatter, signal) => {
        reasons.push(snapshot.reason);

        return format(snapshot, signal);
      },
      failure: (_file, message) => notices.push(message),
      canFormat: () => serverFormats,
      timeoutMs: 10,
    }
  );

  return {
    coordinator,
    notices,
    reasons,
    state: () => ({ text, disk, writes }),
    applies: () => applies,
    noServerFormatter: () => {
      serverFormats = false;
    },
    edit: (next: string) => {
      text = next;
      version++;
      coordinator.invalidate();
    },
    release: () => {
      alive = false;
      coordinator.invalidate();
    },
    failDisk: () => {
      diskOk = false;
    },
    disable: () => {
      enabled = false;
    },
    none: () => {
      selected = P.LanguageFormatterSelection.cases.None.make({});
    },
  };
};

for (const reason of SAVE_REASONS) {
  test(`${reason} awaits formatting before writing`, async () => {
    const gate = deferred<string>();
    const f = fixture(() => gate.promise);
    const saved = f.coordinator.save(reason);

    await Promise.resolve();
    expect(f.state().writes).toBe(0);
    gate.finish("const n = 1;");
    expect(await saved).toBe(true);
    expect(f.state().disk).toBe("const n = 1;");
    expect(f.reasons).toEqual([reason]);
  });
}

test("concurrent entry points coalesce rather than double format/write", async () => {
  const gate = deferred<string>();
  const f = fixture(() => gate.promise);
  const first = f.coordinator.save("autosave");
  const second = f.coordinator.save("close");

  expect(first).toBe(second);
  gate.finish("formatted");
  await first;
  expect(f.state().writes).toBe(1);
  expect(f.reasons.length).toBe(1);
});

test("typing invalidates late formatting and saves the newer text", async () => {
  const gate = deferred<string>();
  const f = fixture(() => gate.promise);
  const pending = f.coordinator.save("manual");

  await Promise.resolve();
  f.edit("newer typing");
  expect(await pending).toBe(true);
  gate.finish("obsolete");
  await Promise.resolve();
  expect(f.state().disk).toBe("newer typing");
  expect(f.notices).toEqual([]);
});

test("timeout aborts the selected formatter but saves text and reports failure", async () => {
  let signal: AbortSignal | null = null;

  const signalAborted = () => signal?.aborted;

  const f = fixture((_snapshot, value) => {
    signal = value;

    return new Promise(() => undefined);
  });

  expect(await f.coordinator.save("manual")).toBe(true);
  expect(f.state().disk).toBe("const n=1");
  expect(f.notices).toEqual(["Formatting timed out."]);
  expect(signalAborted()).toBe(true);
});

test("internal invalidation before the disk read completes discards format without a failure notice", async () => {
  const gate = deferred<string>();
  const f = fixture(() => gate.promise);
  const saved = f.coordinator.save("manual");

  await Promise.resolve();
  f.coordinator.invalidate();
  expect(await saved).toBe(true);
  gate.finish("stale text");
  expect(f.state().disk).toBe("const n=1");
  expect(f.notices).toEqual([]);
});

test("formatter failure saves, autosave notices coalesce, manual notices remain explicit", async () => {
  const f = fixture(async () => {
    throw new Error("Selected tool missing");
  });

  await f.coordinator.save("autosave");
  f.edit("two");
  await f.coordinator.save("autosave");
  expect(f.notices.length).toBe(1);
  await f.coordinator.save("manual");
  expect(f.notices.length).toBe(2);
  expect(f.state().disk).toBe("two");
});

test("disk failure is never a successful save and release rejects late work", async () => {
  const failed = fixture(async () => "formatted");

  failed.failDisk();
  expect(await failed.coordinator.save("quit")).toBe(false);
  const gate = deferred<string>();
  const f = fixture(() => gate.promise);
  const saved = f.coordinator.save("close");

  f.release();
  expect(await saved).toBe(false);
  gate.finish("stale");
  expect(f.state().text).toBe("const n=1");
});

test("negotiated Unicode edits preserve CRLF and reject invalid/overlapping positions", () => {
  const edit = (start: number, end: number) =>
    P.LanguageTextEdit.make({
      range: { start: { line: 0, character: start }, end: { line: 0, character: end } },
      newText: "X",
    });

  expect(formattedText("a😀b\r\nnext", [edit(1, 5)], "utf-8")).toBe("aXb\r\nnext");
  expect(formattedText("a😀b\r\nnext", [edit(1, 3)], "utf-16")).toBe("aXb\r\nnext");
  expect(formattedText("a😀b\r\nnext", [edit(1, 2)], "utf-32")).toBe("aXb\r\nnext");
  expect(() => formattedText("a😀b", [edit(1, 2)], "utf-16")).toThrow();
  expect(() => formattedText("abcd", [edit(0, 3), edit(2, 4)], "utf-16")).toThrow();
  expect(() => formattedText("abcd", [edit(4, 9)], "utf-16")).toThrow();
});

test("Format document formats without saving, whatever Format on save says", async () => {
  const f = fixture(async () => "const n = 1;");

  f.disable();
  f.none();
  expect(await f.coordinator.format()).toBe(true);
  expect(f.state()).toEqual({ text: "const n = 1;", disk: "", writes: 0 });
  expect(f.notices).toEqual([]);
});

test("Format document reports a formatter failure to its caller instead of saving", async () => {
  const f = fixture(async () => {
    throw new Error("formatter-failed");
  });

  const outcome = await f.coordinator.format().then(
    () => "",
    (error: Error) => error.message
  );

  expect(outcome).toBe("formatter-failed");
  expect(f.state().writes).toBe(0);
});

for (const reason of SAVE_REASONS) {
  test(`${reason}: with no formatter chosen, the file's own server formats before the write`, async () => {
    const f = fixture(async () => "const n = 1;");

    f.none();
    expect(await f.coordinator.save(reason)).toBe(true);
    expect(f.state()).toEqual({ text: "const n = 1;", disk: "const n = 1;", writes: 1 });
    expect(f.applies()).toBe(1);
    expect(f.reasons).toEqual([reason]);
  });

  test(`${reason}: no server formats this file, so it saves as typed and says nothing`, async () => {
    const f = fixture(async () => "const n = 1;");

    f.none();
    f.noServerFormatter();
    expect(await f.coordinator.save(reason)).toBe(true);
    expect(f.state().disk).toBe("const n=1");
    expect(f.reasons).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  test(`${reason}: Format on save off saves as typed`, async () => {
    const f = fixture(async () => "const n = 1;");

    f.none();
    f.disable();
    expect(await f.coordinator.save(reason)).toBe(true);
    expect(f.state().disk).toBe("const n=1");
    expect(f.reasons).toEqual([]);
  });
}

test("Format document marks its snapshot as a command; a save doesn't", async () => {
  const commands: (boolean | undefined)[] = [];

  const f = fixture(async (snapshot) => {
    commands.push(snapshot.command);

    return snapshot.text;
  });

  await f.coordinator.format();
  await f.coordinator.save("manual");
  expect(commands).toEqual([true, undefined]);
});
