import { describe, expect, test } from "bun:test";
import { ApprovalRequest, RequestId, SessionId, TurnId } from "@polaris/protocol";
import { Decisions } from "../../../commands.ts";
import { FIXTURE_DATA_APPROVAL } from "../preview/fixtures.ts";
import {
  approvalTitle,
  approveDecision,
  dataSourceTarget,
  rememberedOn,
  scopeNote,
  targetRows,
} from "./model.ts";

const plainTool = new ApprovalRequest({
  id: RequestId.make("r-tool"),
  sessionId: SessionId.make("s"),
  turnId: TurnId.make("t"),
  kind: "tool",
  title: "Run a tool",
  detail: null,
  options: [],
  openedAt: "2026-10-30T18:00:00.000Z",
});

describe("the Data Source Approval (Paper: Let agents read analytics?)", () => {
  test("a tool approval carrying a data source is one; any other isn't", () => {
    expect(dataSourceTarget(FIXTURE_DATA_APPROVAL)?.sourceName).toBe("analytics");
    expect(dataSourceTarget(plainTool)).toBeNull();
  });

  test("the well names the exact target, the branch's identity included", () => {
    const target = dataSourceTarget(FIXTURE_DATA_APPROVAL);

    expect(target === null ? null : approvalTitle(target)).toBe("Let agents read analytics?");
    expect(target === null ? [] : targetRows(target)).toEqual([
      ["Engine", "mysql · PlanetScale"],
      ["Branch", "backfill-currency"],
      ["Server", "aws.connect.psdb.cloud:3306"],
      ["Database", "analytics as u_7kq2xmz4p1"],
    ]);
  });

  test("without a branch or user, the well leaves them out", () => {
    const target = {
      sourceId: "s",
      sourceName: "app",
      engine: "postgres" as const,
      host: "db.internal",
      port: 5432,
      database: "app",
    };

    expect(targetRows(target)).toEqual([
      ["Engine", "postgres"],
      ["Server", "db.internal:5432"],
      ["Database", "app"],
    ]);
    expect(scopeNote(target, "server")).toBeNull();
  });

  test("the server scope covers a provider's branches too", () => {
    const target = dataSourceTarget(FIXTURE_DATA_APPROVAL);

    expect(target === null ? null : scopeNote(target, "server")).toBe("branches too");
    expect(target === null ? null : scopeNote(target, "target")).toBeNull();
  });

  test("Approve remembers the choice at the chosen scope, on the Host", () => {
    expect(approveDecision("server")).toEqual(
      Decisions.Allow({ remember: true, dataScope: "server" })
    );
    expect(rememberedOn("Mac Studio")).toBe("Remembered on Mac Studio");
  });
});
