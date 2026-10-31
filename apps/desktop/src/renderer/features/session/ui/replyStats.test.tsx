import "../../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { ReplyStats } from "@polaris/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { settingsStore } from "../../settings/index.ts";
import { ReplyStatsLine } from "./replyStats.tsx";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(cleanup);

const setAdvanced = (on: boolean) =>
  act(() => {
    settingsStore.setState((s) => ({ sessions: { ...s.sessions, advancedView: on } }));
  });

const reply = (live: boolean) =>
  ({
    kind: "item",
    item: {
      kind: "message",
      id: "m",
      live,
      text: "Done.",
      stats: new ReplyStats({ outputTokens: 842, latencyMs: 1_200, durationMs: 13_365 }),
    },
  }) as const;

test("a finished reply shows its stats only while the advanced view is on", () => {
  const view = render(<ReplyStatsLine entry={reply(false)} />);

  expect(view.queryByTestId("reply-stats")).toBeNull();
  setAdvanced(true);
  expect(view.getByTestId("reply-stats").textContent).toBe("1.2s · 842 tokens · 63 tok/s");
  view.rerender(<ReplyStatsLine entry={reply(true)} />);
  expect(view.queryByTestId("reply-stats")).toBeNull();
  setAdvanced(false);
});
