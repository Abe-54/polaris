import "../../test/dom.testing.ts";
import { ComposerDraft, ContinuityItem, SessionId, TurnId } from "@polaris/protocol";
import { DRAFT_SAVE_DELAY_MS, type DraftStatus } from "@polaris/client/continuity";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeBridge, installFakeBridge } from "../../test/bridge.testing.ts";
import { standInBridge } from "../bridge.ts";
import { useSessionContinuity } from "./continuity.ts";
import { patchSessionUi, uiKey, useSessionUi } from "./state.ts";
import { draftCaption } from "./ui/ComposerStatus.tsx";

const at = "2026-10-27T00:00:00.000Z";

let bridge: FakeBridge;

let count = 0;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

/** The open session on a fresh Host each test, so no feed carries over. */
const openSession = (lastEnded: TurnId | null) => {
  count += 1;
  const hostKey = `h-${count}`;
  const sessionId = SessionId.make(`s-${count}`);

  return { ...mount(hostKey, sessionId, lastEnded), hostKey, sessionId };
};

/** Opens (or reopens) one session's view. */
const mount = (hostKey: string, sessionId: SessionId, lastEnded: TurnId | null) => {
  const key = uiKey(hostKey, sessionId);

  const view = renderHook(
    ({ ended }) => {
      useSessionContinuity({ hostKey, sessionId, enabled: true, lastEnded: ended });

      return useSessionUi(key);
    },
    { initialProps: { ended: lastEnded } }
  );

  return { key, view };
};

const snapshot = (...drafts: ReadonlyArray<ComposerDraft>) =>
  ContinuityItem.cases.Snapshot.make({ reads: [], drafts });

const offline = { code: "NotConnected", message: "The Host is away" };

test("the Host's draft fills the composer, and typing here is saved after a pause", async () => {
  const { hostKey, sessionId, key, view } = openSession(null);
  const feed = bridge.feeds("continuity").at(-1)!;
  expect(feed.input).toEqual({ hostKey });

  act(() =>
    feed.listener.items([
      ContinuityItem.cases.Snapshot.make({
        reads: [],
        drafts: [new ComposerDraft({ sessionId, text: "From the phone", revision: 1, at })],
      }),
    ])
  );
  expect(view.result.current.draft).toBe("From the phone");
  // Restoring isn't a change to write back.
  expect(bridge.sent("continuity.saveDraft")).toEqual([]);

  bridge.answer("continuity.saveDraft", ({ text }) => ({
    ok: true,
    value: { sessionId, text, revision: 2, at },
  }));
  act(() => patchSessionUi(key, () => ({ draft: "From the phone, and the Mac" })));
  expect(bridge.sent("continuity.saveDraft")).toEqual([]);
  await waitFor(
    () =>
      expect(bridge.sent("continuity.saveDraft")).toEqual([
        { hostKey, sessionId, text: "From the phone, and the Mac" },
      ]),
    { timeout: DRAFT_SAVE_DELAY_MS * 4 }
  );
});

test("the newest ended Turn on screen is reported read, once each", () => {
  const first = TurnId.make("t-1");
  const { hostKey, sessionId, view } = openSession(first);
  view.rerender({ ended: first });
  view.rerender({ ended: TurnId.make("t-2") });

  expect(bridge.sent("continuity.markRead")).toEqual([
    { hostKey, sessionId, turnId: first },
    { hostKey, sessionId, turnId: TurnId.make("t-2") },
  ]);
});

test("typing a failed write left on leaving is kept on reopening, and written over the Host's older draft", async () => {
  const { hostKey, sessionId, key, view } = openSession(null);
  const old = new ComposerDraft({ sessionId, text: "old", revision: 1, at });
  act(() =>
    bridge
      .feeds("continuity")
      .at(-1)!
      .listener.items([snapshot(old)])
  );

  bridge.refuse("continuity.saveDraft", offline);
  act(() => patchSessionUi(key, () => ({ draft: "new" })));
  view.unmount();
  await waitFor(() => expect(bridge.sent("continuity.saveDraft")).toHaveLength(1));
  await act(async () => undefined);

  bridge.answer("continuity.saveDraft", ({ text }) => ({
    ok: true,
    value: { sessionId, text, revision: 2, at },
  }));
  const reopened = mount(hostKey, sessionId, null);
  act(() =>
    bridge
      .feeds("continuity")
      .at(-1)!
      .listener.items([snapshot(old)])
  );

  expect(reopened.view.result.current.draft).toBe("new");
  await waitFor(() =>
    expect(bridge.sent("continuity.saveDraft").at(-1)).toEqual({ hostKey, sessionId, text: "new" })
  );
});

test("a draft another Client cleared while this one was away is cleared here", () => {
  const { sessionId, view } = openSession(null);
  const feed = () => bridge.feeds("continuity").at(-1)!;
  act(() =>
    feed().listener.items([
      snapshot(new ComposerDraft({ sessionId, text: "sent elsewhere", revision: 1, at })),
    ])
  );
  expect(view.result.current.draft).toBe("sent elsewhere");

  act(() =>
    feed().listener.items([snapshot(new ComposerDraft({ sessionId, text: "", revision: 2, at }))])
  );
  expect(view.result.current.draft).toBe("");
});

test("a read report the Host refused goes again on reopening and when the Host's feed opens", async () => {
  const turnId = TurnId.make("t-1");
  bridge.refuse("continuity.markRead", offline);
  const { hostKey, sessionId, view } = openSession(turnId);
  await waitFor(() => expect(bridge.sent("continuity.markRead")).toHaveLength(1));
  await act(async () => undefined);

  view.unmount();
  mount(hostKey, sessionId, turnId);
  await waitFor(() => expect(bridge.sent("continuity.markRead")).toHaveLength(2));
  await act(async () => undefined);

  bridge.answerOk("continuity.markRead", { sessionId, turnId, turnIndex: 0, at });
  act(() => bridge.feeds("continuity").at(-1)!.listener.items([snapshot()]));
  await waitFor(() => expect(bridge.sent("continuity.markRead")).toHaveLength(3));
  await act(async () => undefined);

  // Acknowledged now: the next feed sends nothing more.
  act(() => bridge.feeds("continuity").at(-1)!.listener.items([snapshot()]));
  expect(bridge.sent("continuity.markRead")).toEqual(
    Array.from({ length: 3 }, () => ({ hostKey, sessionId, turnId }))
  );
});

const caption = (ui: { readonly draft: string; readonly draftStatus: DraftStatus | null }) =>
  draftCaption(ui.draft, ui.draftStatus);

test("'Draft saved' shows once the Host holds the typing, and 'Draft not saved' when it refused", async () => {
  const { sessionId, key, view } = openSession(null);
  act(() => bridge.feeds("continuity").at(-1)!.listener.items([snapshot()]));

  bridge.answer("continuity.saveDraft", ({ text }) => ({
    ok: true,
    value: { sessionId, text, revision: 1, at },
  }));
  act(() => patchSessionUi(key, () => ({ draft: "Check the token" })));
  expect(caption(view.result.current)).toBeNull();
  await waitFor(() => expect(caption(view.result.current)).toBe("Draft saved"), {
    timeout: DRAFT_SAVE_DELAY_MS * 4,
  });

  bridge.refuse("continuity.saveDraft", offline);
  act(() => patchSessionUi(key, () => ({ draft: "Check the token again" })));
  await waitFor(() => expect(caption(view.result.current)).toBe("Draft not saved"), {
    timeout: DRAFT_SAVE_DELAY_MS * 4,
  });
});

test("a draft restored from the Host reads as saved, and an empty composer says nothing", () => {
  const { sessionId, key, view } = openSession(null);
  act(() =>
    bridge
      .feeds("continuity")
      .at(-1)!
      .listener.items([
        snapshot(new ComposerDraft({ sessionId, text: "From the phone", revision: 1, at })),
      ])
  );
  expect(caption(view.result.current)).toBe("Draft saved");

  act(() => patchSessionUi(key, () => ({ draft: "" })));
  expect(caption(view.result.current)).toBeNull();
});
