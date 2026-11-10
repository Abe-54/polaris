import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ApprovalRequest } from "./domain.ts";

const Json = Schema.fromJsonString(ApprovalRequest);

const wire = {
  id: "request-1",
  sessionId: "session-1",
  turnId: "turn-1",
  kind: "command",
  title: "Run tests",
  detail: "bun test",
  options: [],
  openedAt: "2026-11-09T00:00:00.000Z",
};

test("a Subagent's request names it on the wire", () => {
  const request = Schema.decodeUnknownSync(ApprovalRequest)({ ...wire, subagentId: "toolu_1" });
  const back = Schema.decodeUnknownSync(Json)(Schema.encodeSync(Json)(request));

  expect(String(back.subagentId)).toBe("toolu_1");
});

test("a request from a Daemon before ENG-547 reads as the Turn's own", () => {
  expect(Schema.decodeUnknownSync(ApprovalRequest)(wire).subagentId).toBeNull();
});
