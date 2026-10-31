/**
 * The span panel's Fields tab (DESIGN.md, Traces → Span panel): a Span's fields as groups of
 * key/value rows (`attributes`, `polaris`, `resource`, `scope`, `span`), and the filter over them.
 */
import type { Span, TraceAttributes, TraceTurn } from "@polaris/protocol";
import { Predicate } from "effect";

/** What T1's ingest writes in place of a sensitive attribute's value (ADR 0094). */
export const REDACTED = "[redacted]";

export type FieldGroupName = "attributes" | "polaris" | "resource" | "scope" | "span";

export interface Field {
  readonly key: string;
  readonly value: string;
  /** A quiet note after the value ("process started in turn 9"). */
  readonly note?: string;
  /** The value is SQL, coloured as a query. */
  readonly sql?: boolean;
}

export interface FieldGroup {
  readonly name: FieldGroupName;
  readonly fields: ReadonlyArray<Field>;
}

/** The order Paper T1 draws them in. */
export const FIELD_GROUPS: ReadonlyArray<FieldGroupName> = [
  "attributes",
  "polaris",
  "resource",
  "scope",
  "span",
];

const SQL_KEYS = new Set(["db.query.text", "db.statement"]);

/** An attribute value as text: strings as they are, everything else as JSON. */
export const fieldText = (value: TraceAttributes[string]): string =>
  Predicate.isString(value) ? value : JSON.stringify(value);

const fromAttributes = (attributes: TraceAttributes): ReadonlyArray<Field> =>
  Object.keys(attributes)
    .toSorted()
    .map((key): Field => {
      const field = { key, value: fieldText(attributes[key] ?? null) };

      return SQL_KEYS.has(key) ? { ...field, sql: true } : field;
    });

const turnField = (turn: TraceTurn | null, launched: TraceTurn | null): Field => {
  const value = turn === null ? "between turns" : String(turn.number);

  if (launched === null) return { key: "turn", value };

  return { key: "turn", value, note: `process started in turn ${launched.number}` };
};

/** `sessionTitle` names the Agent Session the Span ran in; null shows its id. */
const polarisFields = (span: Span, sessionTitle: string | null): ReadonlyArray<Field> => {
  const { sessionId, turn, launchedTurn } = span.polaris;

  const session: Field =
    sessionId === null
      ? { key: "agent session", value: "a terminal in this workspace" }
      : { key: "agent session", value: sessionTitle ?? sessionId };

  return [session, turnField(turn, launchedTurn)];
};

const scopeFields = ({ scope }: Span): ReadonlyArray<Field> => [
  { key: "name", value: scope.name },
  ...(scope.version === "" ? [] : [{ key: "version", value: scope.version }]),
  ...fromAttributes(scope.attributes),
];

const dropped = (span: Span): ReadonlyArray<Field> =>
  (
    [
      ["dropped attributes", span.droppedAttributes],
      ["dropped events", span.droppedEvents],
      ["dropped links", span.droppedLinks],
    ] as const
  ).flatMap(([key, n]) => (n > 0 ? [{ key, value: String(n) }] : []));

const spanFields = (span: Span): ReadonlyArray<Field> => [
  { key: "span id", value: span.id },
  { key: "trace id", value: span.traceId },
  { key: "parent id", value: span.parentId ?? "none (root)" },
  { key: "kind", value: span.kind },
  { key: "status", value: span.status },
  ...(span.statusMessage === "" ? [] : [{ key: "status message", value: span.statusMessage }]),
  { key: "start", value: span.startTimeUnixNano },
  { key: "end", value: span.endTimeUnixNano },
  ...(span.traceState === "" ? [] : [{ key: "trace state", value: span.traceState }]),
  ...dropped(span),
];

export const spanFieldGroups = (
  span: Span,
  sessionTitle: string | null
): ReadonlyArray<FieldGroup> => [
  { name: "attributes", fields: fromAttributes(span.attributes) },
  { name: "polaris", fields: polarisFields(span, sessionTitle) },
  { name: "resource", fields: fromAttributes(span.resource) },
  { name: "scope", fields: scopeFields(span) },
  { name: "span", fields: spanFields(span) },
];

/**
 * The groups with only the fields whose key or value contains `query` (any case); a group whose
 * name matches keeps all its fields. Empty groups are dropped; a blank query keeps everything.
 */
export const filterFields = (
  groups: ReadonlyArray<FieldGroup>,
  query: string
): ReadonlyArray<FieldGroup> => {
  const q = query.trim().toLowerCase();

  if (q === "") return groups;

  return groups.flatMap((g) => {
    if (g.name.includes(q)) return [g];

    const fields = g.fields.filter(
      (f) => f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q)
    );

    return fields.length > 0 ? [{ name: g.name, fields }] : [];
  });
};
