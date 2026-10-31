/**
 * The span panel's actions (Paper T1, T2): "Open profile range" when the open Profile recorded
 * part of the span, "Open in Data ⌘4" on a database span whose Data Source this checkout has,
 * and the code location ("overdue.ts:61 ⌘3"), which opens in the Editor.
 */
import type { Span } from "@polaris/protocol";
import { useShellActions } from "../../../../shell/hooks.ts";
import { menuShortcut } from "../../../../shell/menu/index.ts";
import { useDataSources } from "../../../data/data/hooks.tsx";
import { openSqlTab, openTable } from "../../../data/model/store.ts";
import { defaultSchema } from "../../../data/output/model.ts";
import { useOpenInEditor } from "../../../editor-links/index.ts";
import { useOpenTrace } from "../../model/openTrace.ts";
import { overlap, rangeLabel } from "../../model/profile/overlap.ts";
import { setFlameWindow, useProfileSelection } from "../../model/profile/store.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import { type CodeLocation, locationLabel } from "../../model/span/code.ts";
import { spanDataSource, spanTable } from "../../model/span/dataSource.ts";
import { fieldText } from "../../model/span/fields.ts";
import { Pill } from "./parts.tsx";

/** Rendered only for a span with `db.*` attributes, so other spans never watch Data Sources. */
const OpenInData = ({ at, span }: { readonly at: TracesSessionKey; readonly span: Span }) => {
  const listed = useDataSources(at);
  const actions = useShellActions();
  const source = listed.status === "ready" ? spanDataSource(span.attributes, listed.value) : null;

  if (source === null) return null;

  const open = () => {
    const table = spanTable(span.attributes);
    const query = span.attributes["db.query.text"] ?? span.attributes["db.statement"];

    if (table !== null)
      openTable(
        source.name,
        { schema: table.schema ?? defaultSchema(source), name: table.name },
        at
      );
    else if (query !== undefined) openSqlTab(fieldText(query), source.name, at);
    actions.selectSession(at);
    actions.setMode("data");
  };

  return (
    <Pill
      onClick={open}
      hint={menuShortcut("view.data")}
      title={`Open ${source.name} in Data`}
      testId="span-open-data"
    >
      Open in Data
    </Pill>
  );
};

const isDatabase = (span: Span) =>
  span.attributes["db.system.name"] !== undefined || span.attributes["db.system"] !== undefined;

/** The part of the span the open Profile recorded, in ms of the Profile and of the trace. */
const useProfiledPart = (at: TracesSessionKey, span: Span) => {
  const { profile } = useProfileSelection(at);
  const trace = useOpenTrace(at, span.traceId);
  const startNs = BigInt(span.startTimeUnixNano);
  const shared = profile === null ? null : overlap(profile, startNs, BigInt(span.endTimeUnixNano));

  if (shared === null) return null;
  // The pill names the range as the profile header does: in ms of the trace.

  const shift =
    trace === null ? 0 : Number(startNs - BigInt(trace.summary.startTimeUnixNano)) / 1e6;

  return {
    profile: shared.profile,
    trace: { from: shared.stretch.from + shift, to: shared.stretch.to + shift },
  };
};

export const SpanActions = ({
  at,
  span,
  location,
}: {
  readonly at: TracesSessionKey;
  readonly span: Span;
  readonly location: CodeLocation | null;
}) => {
  const openInEditor = useOpenInEditor();
  const profiled = useProfiledPart(at, span);

  if (!isDatabase(span) && location === null && profiled === null) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3.5">
      {profiled === null ? null : (
        <Pill
          onClick={() => setFlameWindow(at, profiled.profile)}
          hint={rangeLabel(profiled.trace)}
          title="Show this span's part of the profile in the flame chart"
          testId="span-open-profile-range"
        >
          Open profile range
        </Pill>
      )}
      {isDatabase(span) ? <OpenInData at={at} span={span} /> : null}
      {location === null ? null : (
        <Pill
          mono
          onClick={() =>
            openInEditor({
              hostKey: at.hostKey,
              root: span.polaris.checkout,
              workspaceId: span.polaris.workspaceId,
              path: location.path,
              line: location.line,
              column: location.column,
            })
          }
          hint={menuShortcut("view.edit")}
          title={`Open ${location.path} in the editor`}
          testId="span-open-code"
        >
          {locationLabel(location)}
        </Pill>
      )}
    </div>
  );
};
