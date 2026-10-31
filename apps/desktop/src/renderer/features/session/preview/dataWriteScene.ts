/**
 * Agents' writes in the conversation and Output's Data tab (`#preview/data-write`, `-worst`,
 * `data-output`; Paper D3): a pending update, each way one ends, and the worst case.
 */
import {
  type DataSchemaDiff,
  type QueryLogEntry,
  RequestId,
  type SchemaSourceDiff,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import type { SessionModel, SettledWrite } from "../../../store/sessionModel.ts";
import { FIXTURE_QUERY_LOG, FIXTURE_SOURCES } from "../../data/preview/fixtures.ts";
import {
  BRANCH_TARGET,
  fixtureWrite,
  fixtureWriteApproval,
  fixtureWriteEntry,
  insertWrite,
  notPreviewedWrite,
  worstWrite,
  withParams,
} from "../../data/preview/writeFixtures.ts";
import type { DataWrite } from "../../data/write/model.ts";
import { model, session, turn, view } from "./fixtures.ts";

const I = TurnItem.cases;

const ID = "s-data-write";

const s = session(ID, {
  title: "Backfill currency",
  harness: "codex",
  state: "needs-you",
  turnCount: 6,
});

const turnId = (index: number) => TurnId.make(`${ID}-t${index}`);

const call = (id: string, sql: string) =>
  I.ToolCall.make({
    id,
    name: "mcp__polaris__execute",
    kind: "other",
    mcp: null,
    input: { source: "app", sql },
    output: null,
    status: "running",
  });

const asked = (write: DataWrite, index: number, n: string) =>
  fixtureWriteApproval(write, { id: `r-${n}`, sessionId: s.id, turnId: turnId(index) });

/** One write per way it ends, each in the Turn it asked in. */
const ENDED: ReadonlyArray<
  readonly [DataWrite, SettledWrite["outcome"], QueryLogEntry["state"] | null, string]
> = [
  [fixtureWrite({ queryId: "q-ran" }), { kind: "allowed" }, "completed", "ran"],
  [fixtureWrite({ queryId: "q-running", affected: 38 }), { kind: "allowed" }, "running", "running"],
  [fixtureWrite({ queryId: "q-failed", affected: 12 }), { kind: "allowed" }, "failed", "failed"],
  [
    fixtureWrite({ queryId: "q-denied", sql: "delete from invoices where currency is null" }),
    { kind: "denied", reason: "Keep them: finance reconciles those by hand on Fridays." },
    null,
    "denied",
  ],
  [fixtureWrite({ queryId: "q-unknown", affected: 1 }), { kind: "allowed" }, "unknown", "unknown"],
  [
    fixtureWrite({ queryId: "q-expired" }),
    { kind: "expired", by: "daemon", reason: "Interrupted" },
    null,
    "expired",
  ],
];

const settledWrites: ReadonlyArray<SettledWrite> = ENDED.map(([write, outcome, , n]) => ({
  request: asked(write, 4, n),
  outcome,
}));

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const author = (index: number) => ({
  kind: "agent" as const,
  sessionId: s.id,
  turn: turnId(index),
});

/** How each ended write's run reads in the Query Log. */
const RUN: Partial<Record<QueryLogEntry["state"], Parameters<typeof fixtureWriteEntry>[2]>> = {
  completed: { rows: 214, affected: [{ schema: "public", table: "invoices", rows: 214 }] },
  failed: {
    error: 'new row for relation "invoices" violates check constraint "invoices_currency_check"',
  },
};

/** The Turns' Query Log: the ended writes' runs, Turn 5's write and its reads. */
const ENTRIES: ReadonlyArray<QueryLogEntry> = [
  ...ENDED.flatMap(([write, , state]) =>
    state === null
      ? []
      : [fixtureWriteEntry(write, state, { author: author(4), at: at(30), ...RUN[state] })]
  ),
  ...FIXTURE_QUERY_LOG.slice(0, 12).map((e, i) =>
    fixtureWriteEntry(fixtureWrite({ queryId: `q-read-${i}` }), "completed", {
      sql: e.sql,
      tool: "data_query",
      author: author(5),
      rows: e.rows ?? 1,
      at: at(10 - i / 2),
    })
  ),
  fixtureWriteEntry(fixtureWrite(), "waiting-approval", {
    author: author(5),
    approval: { id: RequestId.make("r-pending"), status: "pending" },
    at: at(1),
  }),
];

const SCHEMA: SchemaSourceDiff = {
  source: { id: "src-app", name: "app" },
  status: "complete",
  baseline: "turn-start",
  beforeAt: at(12),
  afterAt: at(1),
  truncated: false,
  tables: [
    {
      kind: "changed",
      before: { schema: "public", name: "invoices" },
      after: { schema: "public", name: "invoices" },
      columns: [
        {
          name: "currency",
          before: null,
          after: {
            name: "currency",
            type: "text",
            nullable: true,
            default: null,
            pk: false,
            fk: null,
          },
        },
      ],
      indexes: [],
      constraints: [],
      rows: { kind: "exact", value: 214, agent: 214 },
    },
  ],
};

export const dataWriteFeed = (kind: string): ReadonlyArray<unknown> => {
  if (kind === "data.sources.watch") return [FIXTURE_SOURCES];

  return kind === "data.queryLog.watch" ? [ENTRIES] : [];
};

export const dataWriteSchemaDiff = (turn: TurnId | undefined): DataSchemaDiff =>
  turn === undefined
    ? { sessionId: s.id, sources: [] }
    : { sessionId: s.id, turn, sources: turn === turnId(5) ? [SCHEMA] : [] };

/** Turn 4's writes, each ended; Turn 5's update waiting on the user, with its params. */
export const dataWrite = (): SessionModel => {
  const earlier = turn(s.id, 4, "Backfill the currency on old invoices", "completed");
  const now = turn(s.id, 5, "Try again, only invoices from before 2026", "working");

  return model({
    session: s,
    turns: [
      view(earlier, [
        I.AssistantMessage.make({ id: "m4", text: "Each of these writes needs your approval." }),
      ]),
      view(now, [
        I.AssistantMessage.make({
          id: "m5",
          text: "214 invoices from before 2026 have no currency. I'll set them to USD; here is the dry run.",
        }),
        call("t5", fixtureWrite().sql),
      ]),
    ],
    pendingApprovals: [
      fixtureWriteApproval(withParams(fixtureWrite(), ["2026-01-01", null]), {
        id: "r-pending",
        sessionId: s.id,
        turnId: turnId(5),
      }),
    ],
    settledWrites,
  });
};

/** A wide update on the PlanetScale branch (tan), an insert, and a write with no preview. */
export const dataWriteWorst = (): SessionModel => {
  const worst = session("s-data-worst", {
    title: "Restore the ledger defaults after the import went sideways on the EMEA accounts",
    harness: "claude",
    state: "needs-you",
    turnCount: 1,
  });

  const now = turn(worst.id, 0, "Restore the ledger defaults", "working");

  const on = (write: DataWrite, n: string) =>
    fixtureWriteApproval(write, { id: `r-${n}`, sessionId: worst.id, turnId: now.id });

  return model({
    session: worst,
    turns: [view(now, [call("t1", worstWrite().sql)])],
    pendingApprovals: [
      on(worstWrite(), "worst"),
      on({ ...insertWrite(), target: BRANCH_TARGET }, "insert"),
      on(notPreviewedWrite(), "unpreviewed"),
    ],
  });
};
