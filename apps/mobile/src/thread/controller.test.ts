import { describe, expect, test } from "bun:test";
import {
  ApprovalDecision,
  Attachment,
  AttachmentId,
  Command,
  DomainEvent,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import {
  droppedSend,
  lostAnswer,
  type ThreadController,
  type ThreadState,
  openThread,
} from "./controller.ts";
import {
  at,
  checkpoint,
  ended,
  event,
  type FakeHost,
  type FakeHostOptions,
  finding,
  makeFakeHost,
  request,
  sessionId,
  snapshot,
  started,
  stateChanged,
  summaryAt,
  turn,
} from "./daemon.testing.ts";
import { daemonThreadSource } from "./source.ts";
import { makeThreadRegistry } from "./threads.ts";

const ALL = new Set([
  "session.steer",
  "session.continuity",
  "review.risk-summary",
  "session.turn-paging",
]);

/** Waits for the controller's state to satisfy `ok`, or fails naming what it last held. */
const until = (thread: ThreadController, ok: (state: ThreadState) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (ok(thread.get())) return thread.get();
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }

    return yield* Effect.die(new Error(`never reached; held ${JSON.stringify(thread.get())}`));
  });

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 40)));

const allow = ApprovalDecision.cases.Allow.make({ remember: false });

const withThread = (
  run: (host: FakeHost, thread: ThreadController) => Effect.Effect<void>,
  options: FakeHostOptions & { readonly capabilities?: ReadonlySet<string> } = {}
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeFakeHost(options);

        const source = daemonThreadSource({
          live: host.live,
          capabilities: options.capabilities ?? ALL,
        });

        const thread = openThread(source, sessionId, { draftDelayMs: 10, hostName: "lucas-rpi" });

        yield* Effect.ensuring(
          run(host, thread),
          Effect.sync(() => thread.dispose())
        );
      })
    )
  );

const working = turn(1, { status: "working", endedAt: null });

describe("drafts follow the session", () => {
  test("'Draft saved' shows only once the Host acknowledges the write", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        yield* settle;
        host.holdSaves();
        thread.type("Read the token from the env");
        yield* until(thread, (s) => s.draftStatus === "saving");
        yield* settle;
        expect(thread.get().draftStatus).toBe("saving");
        yield* host.release();
        yield* until(thread, (s) => s.draftStatus === "saved");
      })
    ));

  test("a draft saved on another Client replaces the phone's idle composer", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* settle;
        yield* host.saveElsewhere("typed on the Mac");
        yield* until(thread, (s) => s.text === "typed on the Mac");
      })
    ));

  test("a draft that failed to save is written again when the Host reconnects", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* settle;
        host.failNextSave();
        thread.type("written offline");
        yield* until(thread, (s) => s.draftStatus === "unsaved");

        thread.reconnected();
        yield* until(thread, (s) => s.draftStatus === "saved");
      })
    ));

  test("a Host without continuity never claims a draft is saved", () =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(snapshot([{ turn: turn(0) }]));
          yield* settle;
          thread.type("not synced");
          yield* settle;
          expect(thread.get().draftStatus).toBeNull();
        }),
      { capabilities: new Set(["session.steer"]) }
    ));
});

describe("read position", () => {
  test("reports the newest ended Turn on screen, skips a working one, and never goes back", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }, { turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        yield* settle;
        thread.seen(["t-0", "t-1"]);
        yield* settle;
        thread.seen(["t-0"]);
        yield* settle;
        expect(host.reads).toEqual([0]);
      })
    ));
});

describe("send, steer, queue", () => {
  test("Send steers the Turn in flight when the Host can steer", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        thread.type("use the env var");
        yield* Effect.promise(() => thread.submit());
        expect(host.commands.map((c) => c._tag)).toEqual(["Steer"]);
        expect(thread.get().text).toBe("");
      })
    ));

  test("a steer whose answer is lost names the host, never the transport's error", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        thread.type("use the env var");
        host.dropNextAnswer();
        yield* Effect.promise(() => thread.submit());
        const [lost] = (yield* until(thread, (s) => s.steers[0]?.status === "failed")).steers;
        expect(lost?.error).toBe(lostAnswer("lucas-rpi"));
      })
    ));

  test("a queued follow-up goes as the next Turn only after the Turn in flight ends", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        thread.type("then rerun the tests");
        thread.queue();
        yield* settle;
        expect(host.commands).toEqual([]);
        expect(thread.get().queued).toEqual([{ text: "then rerun the tests", attachments: [] }]);

        yield* host.push(ended(2, turn(1)));
        yield* host.push(stateChanged(3, "idle"));
        yield* until(thread, (s) => s.queued.length === 0);
        const sent = host.commands[0];
        expect(Predicate.isTagged(sent, "SendTurn") && sent.prompt).toBe("then rerun the tests");
      })
    ));

  const shot = new Attachment({
    id: AttachmentId.make("att-1"),
    name: "shot.png",
    mimeType: "image/png",
    size: 10,
    hostPath: "/staging/att-1/shot.png",
    width: 4,
    height: 3,
  });

  test.each([
    ["the Host lacks session.steer-attachments", ALL, true],
    [
      "the Harness doesn't take files in a steer",
      new Set([...ALL, "session.steer-attachments"]),
      false,
    ],
  ])("Send with attachments waits for the Turn in flight when %s", (_, capabilities, harness) =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(snapshot([{ turn: working }], { state: "working" }));
          yield* until(thread, (s) => s.fold !== null);
          thread.type("use this screenshot");
          expect(yield* Effect.promise(() => thread.submit([shot], harness))).toBe(true);
          yield* settle;
          expect(host.commands).toEqual([]);

          yield* host.push(ended(2, turn(1)));
          yield* host.push(stateChanged(3, "idle"));
          yield* until(thread, (s) => s.queued.length === 0);
          expect(host.commands[0]).toEqual(
            Command.cases.SendTurn.make({
              sessionId,
              prompt: "use this screenshot",
              attachments: [shot.id],
            })
          );
        }),
      { capabilities }
    )
  );

  test("Send with attachments steers with them where the Host and Harness take them", () =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(snapshot([{ turn: working }], { state: "working" }));
          yield* until(thread, (s) => s.fold !== null);
          thread.type("use this screenshot");
          expect(yield* Effect.promise(() => thread.submit([shot], true))).toBe(true);
          expect(host.commands).toEqual([
            Command.cases.Steer.make({
              sessionId,
              text: "use this screenshot",
              attachments: [shot.id],
            }),
          ]);
          expect(thread.get().queued).toEqual([]);

          // One that doesn't land gives its files back with its text, to send again.
          yield* host.push(ended(2, turn(1)));
          const failed = yield* until(thread, (s) => s.steers[0]?.status === "failed");
          expect(thread.editSteer(failed.steers[0]?.id ?? "")).toEqual([shot]);
        }),
      { capabilities: new Set([...ALL, "session.steer-attachments"]) }
    ));
});

describe("a steer shows until it lands", () => {
  const landed = (sequence: number, text: string) =>
    event(
      sequence,
      DomainEvent.cases.TurnItemCompleted.make({
        sessionId,
        turnId: TurnId.make("t-1"),
        item: TurnItem.cases.UserMessage.make({ id: `u-${sequence}`, text, startedAt: at }),
        subagentId: null,
      })
    );

  const steering = (thread: ThreadController) =>
    thread.get().steers.map((entry) => `${entry.status}: ${entry.text}`);

  test("in the thread at once, then gone once the Harness takes it in", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        host.holdDispatches();
        thread.type("use the env var");
        const taken = thread.submit();
        yield* settle;
        expect(steering(thread)).toEqual(["sending: use the env var"]);
        expect(thread.get().text).toBe("");

        yield* host.releaseDispatches();
        yield* Effect.promise(() => taken);
        expect(steering(thread)).toEqual(["sent: use the env var"]);
        expect(thread.busy()).toBe(true);

        yield* host.push(landed(2, "use the env var"));
        yield* until(thread, (s) => s.steers.length === 0);
      })
    ));

  test("fails when the Turn ends first, and goes back to the composer to send again", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        thread.type("also run lint");
        yield* Effect.promise(() => thread.submit());

        yield* host.push(ended(2, turn(1)));
        const failed = yield* until(thread, (s) => s.steers[0]?.status === "failed");
        expect(failed.steers[0]?.error).toBe("The turn ended before it landed");

        thread.editSteer(failed.steers[0]?.id ?? "");
        expect(thread.get().steers).toEqual([]);
        expect(thread.get().text).toBe("also run lint");
      })
    ));
});

describe("scrolling back", () => {
  const history = Array.from({ length: 5 }, (_, index) => turn(index));
  const indexes = (state: ThreadState) => state.fold?.turns.map((entry) => entry.turn.index);

  test("pages in the Turns before the feed's, keeps them through a fresh Snapshot, then stops", () =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(snapshot([{ turn: turn(3) }, { turn: turn(4) }]));
          yield* until(thread, (s) => s.fold !== null);

          thread.loadOlder();
          const paged = yield* until(thread, (s) => s.older === "all");
          expect(indexes(paged)).toEqual([0, 1, 2, 3, 4]);

          // A reconnect's Snapshot holds only the recent Turns again.
          yield* host.push(snapshot([{ turn: turn(3) }, { turn: turn(4) }]));
          yield* settle;
          expect(indexes(thread.get())).toEqual([0, 1, 2, 3, 4]);

          thread.loadOlder();
          yield* settle;
          expect(host.pagesAsked).toEqual([3]);
        }),
      { history }
    ));

  test("a Host that can't page to a phone shows what the feed holds, and never asks", () =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(snapshot([{ turn: turn(3) }, { turn: turn(4) }]));
          yield* until(thread, (s) => s.fold !== null);

          thread.loadOlder();
          yield* until(thread, (s) => s.older === "all");
          expect(indexes(thread.get())).toEqual([3, 4]);
          expect(host.pagesAsked).toEqual([]);
        }),
      { history, capabilities: new Set(["session.steer"]) }
    ));
});

describe("the Critical finding", () => {
  const head = "c0ffee";
  const ref = "refs/polaris/checkpoints/s-1/t-1/after";

  test("comes from the summary cached at the last ended Turn's checkpoint", () =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(snapshot([{ turn: working }], { state: "working" }));
          yield* until(thread, (s) => s.fold !== null);
          yield* host.push(checkpoint(2, 1, ref, head));
          yield* host.push(ended(3, turn(1, { checkpointAfter: ref })));
          const state = yield* until(thread, (s) => s.findings.length > 0);
          expect(state.findings.map((f) => f.title)).toEqual(["Secret-like value committed"]);
          expect(host.summariesAsked).toContain(head);
        }),
      { summaries: new Map([[head, summaryAt(head, [finding()])]]) }
    ));

  test("a Snapshot's Turn names its commit, with no checkpoint on this feed", () =>
    withThread(
      (host, thread) =>
        Effect.gen(function* () {
          yield* host.push(
            snapshot([{ turn: turn(1, { checkpointAfter: ref, checkpointAfterCommit: head }) }])
          );
          const state = yield* until(thread, (s) => s.findings.length > 0);
          expect(state.findings.map((f) => f.title)).toEqual(["Secret-like value committed"]);
        }),
      { summaries: new Map([[head, summaryAt(head, [finding()])]]) }
    ));

  test("is absent when no summary is cached, and nothing starts one", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: working }], { state: "working" }));
        yield* until(thread, (s) => s.fold !== null);
        yield* host.push(checkpoint(2, 1, ref, head));
        yield* host.push(ended(3, turn(1, { checkpointAfter: ref })));
        yield* until(thread, () => host.summariesAsked.includes(head));
        yield* settle;
        expect(thread.get().findings).toEqual([]);
      })
    ));
});

describe("pending requests", () => {
  const long = Array.from({ length: 8 }, (_, i) => `step ${i} && echo ${"x".repeat(60)}`).join(
    "\n"
  );

  test("a long command Home can't approve inline is answered in the thread, once", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        const asked = request({ detail: long });
        yield* host.push(snapshot([{ turn: working }], { state: "needs-you" }, [asked]));
        const state = yield* until(thread, (s) => s.fold !== null);
        expect(state.fold?.pendingApprovals.map((r) => r.detail)).toEqual([long]);

        host.holdDispatches();
        const first = thread.respond(asked.id, allow);
        const second = thread.respond(asked.id, allow);
        expect(thread.get().answering).toEqual([asked.id]);
        yield* host.releaseDispatches();
        yield* Effect.promise(() => Promise.all([first, second]));

        const sent = host.commands.filter((c) => Predicate.isTagged(c, "RespondToApproval"));
        expect(sent.length).toBe(1);
        expect(Predicate.isTagged(sent[0], "RespondToApproval") && sent[0].requestId).toBe(
          asked.id
        );
        expect(thread.get().answering).toEqual([]);
      })
    ));
});

describe("a Secret Request", () => {
  const secret = request({ kind: "secret", title: "Tailscale auth key", detail: "To join" });

  const asking = (host: FakeHost, thread: ThreadController) =>
    Effect.gen(function* () {
      yield* host.push(snapshot([{ turn: working }], { state: "needs-you" }, [secret]));
      yield* until(thread, (s) => s.fold !== null);
    });

  test("goes trimmed by secret.provide, never as a command, and leaves nothing in state", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* asking(host, thread);
        yield* Effect.promise(() => thread.provideSecret(secret.id, "  tskey-auth-k1  \n"));

        expect(host.secrets).toEqual([{ requestId: secret.id, value: "tskey-auth-k1" }]);
        expect(host.commands).toEqual([]);
        expect(JSON.stringify(thread.get())).not.toContain("tskey-auth-k1");
      })
    ));

  test("a refusal shows the Host's own words on the card", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* asking(host, thread);
        host.rejectNextSecret("ended", "This request already ended");
        yield* Effect.promise(() => thread.provideSecret(secret.id, "tskey-auth-k1"));

        expect(thread.get().requestErrors.get(secret.id)).toBe("This request already ended");
        expect(thread.get().answering).toEqual([]);
      })
    ));

  test("a value the Host would refuse is never sent, and says why", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* asking(host, thread);
        yield* Effect.promise(() => thread.provideSecret(secret.id, "line one\nline two"));

        expect(host.secrets).toEqual([]);
        expect(thread.get().requestErrors.get(secret.id)).toBe("Use a single line");
      })
    ));
});

describe("one submission, one command", () => {
  test("text typed after Send survives the send's acknowledgement and is saved", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        yield* settle;
        thread.type("message A");
        host.holdDispatches();
        const sending = thread.submit();
        yield* settle;
        thread.type("draft B");
        yield* host.releaseDispatches();
        yield* Effect.promise(() => sending);
        yield* settle;

        expect(host.commands.length).toBe(1);
        expect(thread.get().text).toBe("draft B");
        expect(host.saved.at(-1)).toBe("draft B");
      })
    ));

  test("Return and the Send button before the Host answers make one Turn", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        thread.type("run the tests");
        host.holdDispatches();
        const keyboard = thread.submit();
        const button = thread.submit();
        yield* host.releaseDispatches();
        yield* Effect.promise(() => Promise.all([keyboard, button]));
        expect(host.commands.map((c) => c._tag)).toEqual(["SendTurn"]);
      })
    ));

  test("a retry after a lost answer reuses the command id; a new message gets its own", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        thread.type("run the tests");
        host.dropNextAnswer();
        yield* Effect.promise(() => thread.submit());
        const [lost] = (yield* until(thread, (s) => s.sends[0]?.status === "failed")).sends;
        expect(lost?.error).toBe(droppedSend("lucas-rpi"));

        thread.sendAgain(lost!.id);
        yield* until(thread, (s) => s.sends[0]?.status === "sent");
        yield* host.push(started(2, turn(1, { status: "working", endedAt: null })));
        yield* until(thread, (s) => s.sends.length === 0);
        yield* host.push(ended(3, turn(1)));
        yield* host.push(stateChanged(4, "idle"));
        yield* until(thread, (s) => s.fold?.turns.at(-1)?.turn.status === "completed");
        thread.type("then lint");
        yield* Effect.promise(() => thread.submit());
        yield* until(thread, (s) => s.sends.length === 1 && s.sends[0]?.status === "sent");
        const [first, retry, next] = host.commandIds;
        expect(retry).toBe(first);
        expect(next).not.toBe(first);
      })
    ));
});

describe("a send while the host is away (MX-AV)", () => {
  test("shows queued, goes once the host is back, and leaves when its turn starts", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        host.goAway();
        thread.hostLive(false);
        thread.type("rerun the flaky test");
        expect(yield* Effect.promise(() => thread.submit())).toBe(true);
        yield* settle;

        expect(thread.get().text).toBe("");
        expect(thread.get().sends.map((entry) => [entry.text, entry.status])).toEqual([
          ["rerun the flaky test", "queued"],
        ]);
        expect(host.commands).toEqual([]);

        yield* host.comeBack();
        thread.hostLive(true);
        yield* until(thread, (s) => s.sends[0]?.status === "sent");
        expect(host.commands.map((c) => Predicate.isTagged(c, "SendTurn") && c.prompt)).toEqual([
          "rerun the flaky test",
        ]);

        yield* host.push(started(2, turn(1, { status: "working", endedAt: null })));
        yield* until(thread, (s) => s.sends.length === 0);
      })
    ));

  test("a second message while one is queued waits for its turn, then goes as the next", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        host.goAway();
        thread.hostLive(false);
        thread.type("first");
        yield* Effect.promise(() => thread.submit());
        thread.type("second");
        yield* Effect.promise(() => thread.submit());
        expect(thread.get().queued.map((held) => held.text)).toEqual(["second"]);

        yield* host.comeBack();
        thread.hostLive(true);
        yield* until(thread, (s) => s.sends[0]?.status === "sent");
        // An unrelated change on the feed before the first Turn starts sends nothing more.
        yield* host.push(stateChanged(2, "idle"));
        yield* settle;
        expect(host.commands.length).toBe(1);

        yield* host.push(started(3, turn(1, { status: "working", endedAt: null })));
        yield* host.push(ended(4, turn(1)));
        yield* host.push(stateChanged(5, "idle"));
        yield* until(thread, (s) => s.queued.length === 0);
        yield* settle;
        expect(host.commands.map((c) => Predicate.isTagged(c, "SendTurn") && c.prompt)).toEqual([
          "first",
          "second",
        ]);
      })
    ));

  test("keeps its thread open after the screen lets go, until it is sent", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeFakeHost();
          const registry = makeThreadRegistry();
          const source = daemonThreadSource({ live: host.live, capabilities: ALL });
          const lease = registry.acquire("h/s-1", () => openThread(source, sessionId));
          const thread = lease!.controller;
          yield* host.push(snapshot([{ turn: turn(0) }]));
          yield* until(thread, (s) => s.fold !== null);
          host.goAway();
          thread.hostLive(false);
          thread.type("sent from the train");
          yield* Effect.promise(() => thread.submit());
          lease!.release();

          expect(registry.acquire("h/s-1", null)?.controller).toBe(thread);
          yield* host.comeBack();
          yield* until(thread, (s) => s.sends[0]?.status === "sent");
          expect(host.commands.length).toBe(1);
        })
      )
    ));
});

describe("a failed send (MX-AV)", () => {
  test("stays in the thread with the host's reason, and Send again sends it", () =>
    withThread((host, thread) =>
      Effect.gen(function* () {
        yield* host.push(snapshot([{ turn: turn(0) }]));
        yield* until(thread, (s) => s.fold !== null);
        host.refuseNext("the session is archived");
        thread.type("try again");
        yield* Effect.promise(() => thread.submit());
        const [failed] = (yield* until(thread, (s) => s.sends[0]?.status === "failed")).sends;
        expect(failed?.error).toBe("the session is archived");
        expect(thread.get().text).toBe("");
        expect(thread.busy()).toBe(false);

        thread.sendAgain(failed!.id);
        yield* until(thread, (s) => s.sends[0]?.status === "sent");
        expect(host.commands.length).toBe(1);
      })
    ));
});

describe("the thread outlives its screen", () => {
  test("queued follow-ups survive the screen letting go and coming back", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeFakeHost();
          const registry = makeThreadRegistry();
          const source = daemonThreadSource({ live: host.live, capabilities: ALL });
          let opened = 0;

          const open = () => {
            opened++;

            return openThread(source, sessionId, { draftDelayMs: 10 });
          };

          const first = registry.acquire("h/s-1", open);
          yield* host.push(snapshot([{ turn: working }], { state: "working" }));
          yield* until(first!.controller, (s) => s.fold !== null);
          first!.controller.type("then rerun the tests");
          first!.controller.queue();
          first!.release();

          // A reconnect or a deliberate Back: the screen comes again for the same Host and session.
          const again = registry.acquire("h/s-1", null);
          expect(again?.controller.get().queued).toEqual([
            { text: "then rerun the tests", attachments: [] },
          ]);
          expect(again?.controller.get().fold).not.toBeNull();
          again!.release();

          yield* host.push(ended(2, turn(1)));
          yield* host.push(stateChanged(3, "idle"));
          yield* until(again!.controller, (s) => s.queued.length === 0);
          yield* settle;
          expect(host.commands.map((c) => c._tag)).toEqual(["SendTurn"]);

          // Nothing pending and no screen: closed, so the next screen opens a fresh one.
          expect(registry.acquire("h/s-1", null)).toBeNull();
          registry.acquire("h/s-1", open)?.release();
          expect(opened).toBe(2);
        })
      )
    ));
});

describe("a follow-up keeps its thread until it lands", () => {
  test("a follow-up whose answer is lost after the screen let go is still queued for retry", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeFakeHost();
          const registry = makeThreadRegistry();
          const source = daemonThreadSource({ live: host.live, capabilities: ALL });
          const open = () => openThread(source, sessionId, { draftDelayMs: 10 });

          const first = registry.acquire("h/s-1", open);
          yield* host.push(snapshot([{ turn: working }], { state: "working" }));
          yield* until(first!.controller, (s) => s.fold !== null);
          first!.controller.type("then rerun the tests");
          first!.controller.queue();
          first!.release();

          host.dropNextAnswer();
          yield* host.push(ended(2, turn(1)));
          yield* host.push(stateChanged(3, "idle"));
          yield* until(first!.controller, (s) => s.error !== null);
          yield* settle;

          const again = registry.acquire("h/s-1", null);
          expect(again?.controller).toBe(first!.controller);
          expect(again?.controller.get().queued).toEqual([
            { text: "then rerun the tests", attachments: [] },
          ]);
          again?.release();
        })
      )
    ));
});
