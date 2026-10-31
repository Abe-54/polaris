import { expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { generationOf, refreshSources } from "./refresh.ts";

test("refreshing re-subscribes at most once a second per session", () => {
  const at = { hostKey: "h-refresh", sessionId: SessionId.make("s-refresh") };
  const other = { ...at, sessionId: SessionId.make("s-other") };

  for (const now of [0, 400, 999, 1000, 1500, 2100]) refreshSources(at, now);
  refreshSources(other, 400);

  expect([generationOf(at), generationOf(other)]).toEqual([3, 1]);
});
