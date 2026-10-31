import { Schema } from "effect";
import type { DataSource, Span, SpanDetail, TraceAttributes } from "@polaris/protocol";
import { capSections, duration, inline, offset, projectFrames } from "./traceFormat.ts";

const attributeText = (attributes: TraceAttributes) =>
  Object.entries(attributes).map(
    ([key, value]) =>
      `  ${inline(key)}: ${Schema.is(Schema.String)(value) ? inline(value) : JSON.stringify(value)}`
  );

const value = (span: Span, ...keys: string[]) => {
  for (const key of keys) {
    const found = span.attributes[key];

    if (Schema.is(Schema.Union([Schema.String, Schema.Number]))(found)) return String(found);
  }

  return undefined;
};

/** Match only a known database target; never guess from the SQL or a name alone. */
export const matchingSource = (span: Span, sources: ReadonlyArray<DataSource>) => {
  const engine = value(span, "db.system.name", "db.system");
  const host = value(span, "server.address", "net.peer.name", "db.hostname");
  const port = value(span, "server.port", "net.peer.port");
  const database = value(span, "db.namespace", "db.name");

  if (engine === undefined || host === undefined || database === undefined) return undefined;

  const normalize = (name: string) =>
    ["localhost", "127.0.0.1", "::1"].includes(name) ? "loopback" : name;

  const matches = sources.filter(
    (source) =>
      (source.engine === engine || (source.engine === "postgres" && engine === "postgresql")) &&
      normalize(source.host) === normalize(host) &&
      source.database === database &&
      source.port === Number(port ?? (source.engine === "postgres" ? 5432 : 3306))
  );

  return matches.length === 1 ? { id: matches[0]!.id, name: matches[0]!.name } : undefined;
};

export const spanView = (
  detail: SpanDetail,
  start: string,
  dataSource?: { id: string; name: string }
) => {
  const span = detail.span;

  const lines = [
    `${inline(span.name)} · ${span.kind} · ${inline(span.service)} · ${span.status} · ${duration(span.durationMs)}`,
    `Trace: ${span.traceId} · span ${span.id}`,
    `Offset: +${offset(span, start)} · parent ${span.parentId ?? "none"}`,
    `Time: ${span.startTimeUnixNano}–${span.endTimeUnixNano}`,
    `Status message: ${inline(span.statusMessage)} · trace state: ${inline(span.traceState)}`,
    `Turn: ${span.polaris.turn?.number ?? "between turns"}`,
  ];

  if (span.polaris.launchedTurn !== null)
    lines.push(`Launched turn: ${span.polaris.launchedTurn.number}`);

  if (dataSource !== undefined)
    lines.push(`Data source: ${inline(dataSource.name)} · use describe or query`);
  const file = value(span, "code.file.path", "code.filepath");
  const line = value(span, "code.line.number", "code.lineno");

  if (file !== undefined)
    lines.push(`Code: ${inline(file)}${line === undefined ? "" : `:${inline(line)}`}`);
  const { launchedTurn, ...attribution } = span.polaris;

  const polaris = launchedTurn === null ? attribution : span.polaris;

  lines.push(
    "attributes",
    ...attributeText(span.attributes),
    "polaris",
    ...attributeText({ ...polaris }),
    "resource",
    ...attributeText(span.resource),
    "scope",
    `  name: ${inline(span.scope.name)}`,
    `  version: ${inline(span.scope.version)}`,
    ...attributeText(span.scope.attributes),
    "events"
  );

  for (const event of span.events) {
    lines.push(
      `  ${inline(event.name)} · ${event.timeUnixNano} · ${event.droppedAttributes} dropped attributes`
    );
    const { ["exception.stacktrace"]: stack, ...attributes } = event.attributes;
    lines.push(...attributeText(attributes));

    if (Schema.is(Schema.String)(stack))
      lines.push(
        "  exception stack",
        ...projectFrames(stack, span.polaris.checkout).map((frame) => `    ${inline(frame)}`)
      );
  }

  lines.push(`logs · ${detail.logs.length} of ${detail.logCount}`);

  for (const log of detail.logs) {
    lines.push(
      `  ${log.timeUnixNano} ${inline(log.severityText)} ${Schema.is(Schema.String)(log.body) ? inline(log.body) : JSON.stringify(log.body)}`,
      ...attributeText(log.attributes)
    );
  }

  if (detail.logCount > detail.logs.length)
    lines.push(
      `… ${detail.logCount - detail.logs.length} older logs omitted; newest 20 retained in this response.`
    );
  lines.push("links");

  for (const link of span.links)
    lines.push(
      `  trace ${link.traceId} span ${link.spanId} · ${inline(link.traceState)} · ${link.droppedAttributes} dropped attributes`,
      ...attributeText(link.attributes)
    );
  lines.push(
    `Dropped by exporter: ${span.droppedAttributes} attributes, ${span.droppedEvents} events, ${span.droppedLinks} links`
  );

  return {
    text: capSections(lines, "span"),
    data: { ...detail, ...(dataSource === undefined ? undefined : { dataSource }) },
  };
};
