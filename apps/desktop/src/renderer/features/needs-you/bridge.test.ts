import { SessionId } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { leadKey, leadUi, patchLeadUi } from "../constellation/state.ts";
import { onNeedsYouEvent } from "./bridge.ts";

const LEAD = SessionId.make("lead-1");

const opened = (action: "open" | "open-constellation") => {
  const selected: Array<{ hostKey: string; sessionId: string }> = [];

  patchLeadUi(leadKey("mac", LEAD), () => ({ tab: "changes" }));
  onNeedsYouEvent(
    { kind: "needs-you", action, hostKey: "mac", sessionId: LEAD },
    { selectSession: (target) => selected.push(target), showSidebar: () => undefined },
    () => undefined
  );

  return { selected, tab: leadUi(leadKey("mac", LEAD)).tab };
};

test("a Constellation notification opens the Lead with its Constellation view in front", () => {
  expect(opened("open-constellation")).toEqual({
    selected: [{ hostKey: "mac", sessionId: LEAD }],
    tab: "constellation",
  });
});

test("a session notification opens the session and leaves the Lead's tab as it was", () => {
  expect(opened("open").tab).toBe("changes");
});
