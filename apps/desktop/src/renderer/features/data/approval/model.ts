/**
 * The Data Source Approval (DESIGN.md, Data → approval; Paper "Let agents read analytics?"): the
 * exact target an agent asks to reach, its scope, and the decision Approve sends. Pure.
 */
import { type ApprovalDecision, type ApprovalRequest, DataEngine } from "@polaris/protocol";
import { Option, Schema } from "effect";
import { Decisions } from "../../../commands.ts";

/** X's `ApprovalRequest.dataSource`, read here until it lands in the protocol (ENG-644). */
export const DataSourceTarget = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
  engine: DataEngine,
  host: Schema.String,
  port: Schema.Number,
  database: Schema.String,
  user: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(
    Schema.Struct({ provider: Schema.Literals(["planetscale", "neon"]), name: Schema.String })
  ),
});

export type DataSourceTarget = typeof DataSourceTarget.Type;

const WithTarget = Schema.Struct({ dataSource: DataSourceTarget });

/** The target of a Data Source Approval; null for any other approval. */
export const dataSourceTarget = (request: ApprovalRequest): DataSourceTarget | null =>
  request.kind === "tool"
    ? Option.getOrNull(
        Option.map(Schema.decodeUnknownOption(WithTarget)(request), (r) => r.dataSource)
      )
    : null;

export type DataScope = "target" | "server";

export const SCOPES: ReadonlyArray<{ readonly scope: DataScope; readonly label: string }> = [
  { scope: "target", label: "This database, as this user" },
  { scope: "server", label: "Every database on this server" },
];

const PROVIDER = { planetscale: "PlanetScale", neon: "Neon" } as const;

/** "Let agents read analytics?" */
export const approvalTitle = (target: DataSourceTarget) => `Let agents read ${target.sourceName}?`;

/** "Backfill currency wants to query it. No agent can reach it until you approve it." */
export const approvalBody = (who: string) =>
  `${who} wants to query it. No agent can reach it until you approve it.`;

/** The well's rows: what Approve lets agents reach, exactly. */
export const targetRows = (
  target: DataSourceTarget
): ReadonlyArray<readonly [label: string, value: string]> => [
  [
    "Engine",
    target.branch === undefined
      ? target.engine
      : `${target.engine} · ${PROVIDER[target.branch.provider]}`,
  ],
  ...(target.branch === undefined ? [] : [["Branch", target.branch.name] as const]),
  ["Server", `${target.host}:${target.port}`],
  [
    "Database",
    target.user === undefined || target.user === ""
      ? target.database
      : `${target.database} as ${target.user}`,
  ],
];

/** " · branches too" on a branching provider, where the server holds every branch. */
export const scopeNote = (target: DataSourceTarget, scope: DataScope) =>
  scope === "server" && target.branch !== undefined ? "branches too" : null;

/** "Remembered on Mac Studio": an approval lives on the Host that holds the connection. */
export const rememberedOn = (hostLabel: string) => `Remembered on ${hostLabel}`;

export const DATA_APPROVAL_FOOTNOTE =
  "Reads only. Writes stay off until you allow them for this data source. Agents never see the password.";

export const approveDecision = (scope: DataScope): ApprovalDecision =>
  Decisions.Allow({ remember: true, dataScope: scope });

export const denyDecision = (): ApprovalDecision => Decisions.Deny({ reason: null });
