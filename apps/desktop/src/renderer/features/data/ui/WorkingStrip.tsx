/**
 * The Working strip over a table an agent is querying (DESIGN.md, Data; the Editor's strip, Paper
 * X-I): the live dither, "Fix overdue totals is reading this table" in its Harness hue, the Turn
 * and its elapsed time, Open session and Stop.
 */
import {
  Button,
  Dither,
  harnessHue,
  harnessTextVar,
  hueVar,
  LiveDither,
  StopIcon,
} from "@polaris/ui";
import { useMemo } from "react";
import { Commands } from "../../../commands.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import { elapsed } from "../../editor/model/agent.ts";
import { send } from "../../session/dispatch.ts";
import { useQueryLog } from "../data/hooks.tsx";
import { useWorkingLookup } from "../data/sessions.ts";
import type { DataSessionKey } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { readerTitle, type TableReader, tableReader } from "../model/working.ts";

type TableTab = Extract<DataTab, { kind: "table" }>;

const Strip = ({ hostKey, reader }: { hostKey: string; reader: TableReader }) => {
  // Ticks once a second, only while the strip shows.
  const now = useNow(1000);
  const { selectSession } = useShellActions();
  const { sessionId, harness } = reader;

  return (
    <div
      role="status"
      data-testid="data-working-strip"
      className="relative isolate flex h-[42px] shrink-0 items-center gap-2.5 overflow-clip border-b pr-2 pl-4"
      style={{ borderBottomColor: `color-mix(in srgb, ${hueVar(harness)} 20%, transparent)` }}
    >
      <LiveDither harness={harness} active className="-z-10" />
      <Dither hue={harness} size={12} moving />
      <span
        className="text-label min-w-0 shrink truncate"
        style={{ color: harnessTextVar(harness) }}
      >
        {readerTitle(reader)}
      </span>
      <span className="text-caption text-text-subtle tabular shrink-0">
        {`${harnessHue(harness).name} · turn ${reader.turn} · ${elapsed(now - Date.parse(reader.turnStartedAt))}`}
      </span>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full"
        onClick={() => selectSession({ hostKey, sessionId })}
      >
        Open session
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        onClick={() => void send(hostKey, Commands.Interrupt({ sessionId }), "Couldn't stop")}
        data-testid="data-working-stop"
      >
        <StopIcon size={10} />
        Stop
      </Button>
    </div>
  );
};

/** Shows over a table tab while a Working agent's current Turn is querying that table. */
export const WorkingStrip = ({
  at,
  hostKey,
  tab,
}: {
  at: DataSessionKey;
  hostKey: string;
  tab: TableTab;
}) => {
  const log = useQueryLog(at);
  const lookup = useWorkingLookup(hostKey);
  const entries = log.status === "ready" ? log.value : null;

  const reader = useMemo(
    () =>
      entries === null
        ? null
        : tableReader(entries, lookup, { source: tab.sourceId, table: tab.table }),
    [entries, lookup, tab.sourceId, tab.table]
  );

  return reader === null ? null : <Strip hostKey={hostKey} reader={reader} />;
};
