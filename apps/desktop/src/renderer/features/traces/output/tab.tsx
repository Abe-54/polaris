/**
 * Output's Traces tab beside Changes and Data: visible while the Turn shown has traces, labelled
 * "Traces 14 · 1 error", shown when picked and nothing else is.
 */
import type { SessionId } from "@polaris/protocol";
import { OutputTab } from "../../session/ui/SubagentOutput.tsx";
import type { TracesOutputProps } from "./TracesOutput.tsx";
import { setTracesOutputShown, useTracesOutputShown } from "./state.ts";
import { useTurnTraces } from "./useTurnTraces.ts";

/** The Turn group Output shows: its number and its Turns. */
export interface ShownTurn {
  readonly number: number;
  readonly views: ReadonlyArray<{ readonly turn: { readonly id: string } }>;
}

export interface TracesTab {
  readonly visible: boolean;
  /** The tab's body props while it shows; null otherwise. */
  readonly shown: TracesOutputProps | null;
  readonly total: number;
  readonly errors: number;
}

/** `uiKey` is the session's; `free` is false while a Subagent, the Browser or Data shows. */
export const useTracesTab = (
  hostKey: string,
  sessionId: SessionId,
  uiKey: string,
  turn: ShownTurn | null,
  free: boolean
): TracesTab => {
  const traces = useTurnTraces(hostKey, sessionId, turn?.views.map((v) => v.turn.id) ?? []);
  const visible = traces !== null && traces.total > 0;
  const picked = useTracesOutputShown(uiKey) && visible && free;

  return {
    visible,
    total: traces?.total ?? 0,
    errors: traces?.errors ?? 0,
    shown:
      picked && traces !== null && turn !== null
        ? { hostKey, sessionId, traces, turnNumber: turn.number }
        : null,
  };
};

/** "Traces 14 · 1 error", the errors in `critical-text`; picking it leaves the other tabs. */
export const TracesOutputTab = ({
  tab,
  uiKey,
  onPick,
}: {
  readonly tab: TracesTab;
  readonly uiKey: string;
  readonly onPick: () => void;
}) =>
  tab.visible ? (
    <OutputTab
      id="traces"
      on={tab.shown !== null}
      onClick={() => {
        onPick();
        setTracesOutputShown(uiKey, true);
      }}
    >
      <TabLabel tab={tab} />
    </OutputTab>
  ) : null;

const TabLabel = ({ tab }: { readonly tab: TracesTab }) => (
  <>
    Traces
    <span className="text-text-faint tabular font-mono text-[11px]">{tab.total}</span>
    {tab.errors === 0 ? null : (
      <span className="text-severity-critical-text tabular font-mono text-[11px]">
        · {tab.errors === 1 ? "1 error" : `${tab.errors} errors`}
      </span>
    )}
  </>
);
