import { afterEach, describe, expect, test } from "bun:test";
import { type SchemaSourceDiff, type SchemaTableDiff, SessionId, TurnId } from "@polaris/protocol";
import { reviewRoute } from "../../../routes/review.ts";
import { subjectPick } from "../../review/ui/SessionReview.tsx";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { fixtureWrite, fixtureWriteEntry } from "../preview/writeFixtures.ts";
import { dataSessionKey, dataTabsStore } from "../model/store.ts";
import { dataOpeners } from "./open.ts";

const at = { hostKey: "local", sessionId: SessionId.make("s-open") };

const [APP] = FIXTURE_SOURCES;

const modes: Array<string> = [];

const actions = { selectSession: () => undefined, setMode: (mode: string) => modes.push(mode) };

const open = dataOpeners(at, APP === undefined ? [] : [APP], actions);

afterEach(() => {
  dataTabsStore.setState({ sessions: {}, shown: null });
  reviewRoute.setState({ subject: null });
  modes.length = 0;
});

const activeTab = () => {
  const tabs = dataTabsStore.getState().sessions[dataSessionKey(at)];

  return tabs?.tabs.find((t) => t.id === tabs.active);
};

const table = (name: string, kind: SchemaTableDiff["kind"]): SchemaTableDiff => ({
  kind,
  before: kind === "added" ? null : { schema: "billing", name },
  after: kind === "removed" ? null : { schema: "billing", name },
  columns: [],
  indexes: [],
  constraints: [],
  rows: { kind: "unknown", value: null },
});

const diff = (tables: ReadonlyArray<SchemaTableDiff>): SchemaSourceDiff => ({
  source: { id: APP?.id ?? "", name: APP?.name ?? "" },
  status: "complete",
  baseline: "turn-start",
  beforeAt: null,
  afterAt: null,
  truncated: false,
  tables,
});

describe("Open in Data opens the table the write or schema change touched (F11)", () => {
  test("a write not yet counted opens the schema its SQL names, not the default one", () => {
    const write = fixtureWrite({ sql: "update billing.invoices set currency = 'EUR'" });

    open.write({ entry: fixtureWriteEntry(write, "running"), approval: null });

    expect(activeTab()).toMatchObject({ ref: { schema: "billing", name: "invoices" } });
    expect(modes).toEqual(["data"]);
  });

  test("a schema change opens the first table that still exists, skipping a removed one", () => {
    open.schema(diff([table("legacy", "removed"), table("invoices", "changed")]));

    expect(activeTab()).toMatchObject({ ref: { schema: "billing", name: "invoices" } });
  });
});

test("the Data tab's Schema diff opens Review at the Turn it shows (F12)", () => {
  open.schemaDiff(diff([table("invoices", "changed")]), {
    number: 5,
    ids: ["turn-5", "turn-5b"],
  });

  const subject = reviewRoute.getState().subject;

  expect(subject?.kind === "session" ? subjectPick(subject) : null).toEqual({
    kind: "turn",
    turnId: TurnId.make("turn-5"),
  });
  expect(modes).toEqual(["review"]);
});
