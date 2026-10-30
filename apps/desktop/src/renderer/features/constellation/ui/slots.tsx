/**
 * The shell's session slots, Constellation-aware: a Lead's Intent swaps to a focused worker
 * or handover and shows digest cards; its Output gains the Constellation tab; a worker's
 * Intent shows its brief and Claim.
 */
import type { SessionId } from "@polaris/protocol";
import { Button, ChevronRightIcon, IconButton, Kbd } from "@polaris/ui";
import { useEffect } from "react";
import { useApp, useCommands } from "../../../shell/hooks.ts";
import type { TurnView } from "../../../store/sessionModel.ts";
import { sessionKey } from "../../../store/store.ts";
import {
  BrowserOutputTab,
  closeSubagent,
  hideOutput,
  leaveBrowser,
  offerOutput,
  OutputTab,
  type SessionChrome,
  SessionChromeContext,
  SessionIntent,
  SessionOutput,
  useShownSubagent,
} from "../../session/index.ts";
import { browserKey, useBrowserUi } from "../../browser/index.ts";
import { useFacts, useLeadConstellation, useWorkerAttempt, type WorkerAttempt } from "../hooks.ts";
import {
  type ConstellationRecord,
  type Digest,
  digestFold,
  steeredDigest,
} from "../model/index.ts";
import { leadKey, patchLeadUi, useLeadUi } from "../state.ts";
import { DigestCard } from "./cards.tsx";
import { ConstellationTab } from "./ConstellationTab.tsx";
import { HandoverFocus, useWorkerChrome, WorkerFocus } from "./focus.tsx";

export interface SessionSlot {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

const NO_TURNS: ReadonlyArray<TurnView> = [];

const useTitle = (hostKey: string, sessionId: string) =>
  useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.title ?? "the lead");

const LeadIntent = ({
  hostKey,
  sessionId,
  record,
}: SessionSlot & { readonly record: ConstellationRecord }) => {
  const ui = useLeadUi(leadKey(hostKey, sessionId));
  const leadTitle = useTitle(hostKey, sessionId);
  const facts = useFacts(record);

  // Only a digest Polaris started a Turn for takes that Turn's prompt; a steered one doesn't.
  const digests = new Map<string, Digest>(
    record.digests.flatMap((d) => (d.steered === true ? [] : [[d.turnId, d]]))
  );

  const turns = useApp((s) => s.sessions[sessionKey(hostKey, sessionId)]?.turns) ?? NO_TURNS;

  // A Lead's Output holds its Constellation: open it unless the user chose otherwise.
  useEffect(() => offerOutput(hostKey, sessionId), [hostKey, sessionId]);

  if (ui.focus?.kind === "task")
    return (
      <WorkerFocus
        leadHostKey={hostKey}
        record={record}
        taskId={ui.focus.taskId}
        leadTitle={leadTitle}
      />
    );

  if (ui.focus?.kind === "handover")
    return (
      <HandoverFocus
        leadHostKey={hostKey}
        record={record}
        revision={ui.focus.revision}
        leadTitle={leadTitle}
      />
    );

  const chrome: SessionChrome = {
    openTask: (taskId) =>
      patchLeadUi(leadKey(hostKey, sessionId), () => ({ focus: { kind: "task", taskId } })),
    promptCard: ({ turnId, folded, canFold, onToggle }) => {
      const digest = digests.get(turnId);
      const view = turns.find((t) => t.turn.id === turnId);

      return digest === undefined ? null : (
        <DigestCard
          record={record}
          digest={digest}
          facts={facts}
          folded={folded}
          onToggle={canFold ? onToggle : null}
          fold={view === undefined ? null : digestFold(turns, view)}
        />
      );
    },
    // A steered digest is part of the Turn it landed in: that Turn folds it, the card doesn't.
    steerCard: ({ turnId, itemId }) => {
      const view = turns.find((t) => t.turn.id === turnId);
      const digest = view === undefined ? null : steeredDigest(record.digests, view, itemId);

      return digest === null ? null : (
        <DigestCard
          record={record}
          digest={digest}
          facts={facts}
          folded={false}
          onToggle={null}
          fold={null}
        />
      );
    },
  };

  return (
    <SessionChromeContext.Provider value={chrome}>
      <SessionIntent hostKey={hostKey} sessionId={sessionId} />
    </SessionChromeContext.Provider>
  );
};

const WorkerIntent = ({
  hostKey,
  sessionId,
  worker,
}: SessionSlot & { readonly worker: WorkerAttempt }) => {
  const leadTitle = useTitle(worker.leadHostKey, worker.view.constellation.leadSessionId);

  const chrome = useWorkerChrome({
    leadHostKey: worker.leadHostKey,
    record: worker.view,
    task: worker.task,
    attempt: worker.attempt,
    leadTitle,
  });

  return (
    <SessionChromeContext.Provider value={chrome}>
      <SessionIntent hostKey={hostKey} sessionId={sessionId} />
    </SessionChromeContext.Provider>
  );
};

/** The `SessionIntent` slot. */
export const ConstellationIntent = ({ hostKey, sessionId }: SessionSlot) => {
  const lead = useLeadConstellation(hostKey, sessionId);
  const worker = useWorkerAttempt(hostKey, sessionId);

  if (lead !== null) return <LeadIntent hostKey={hostKey} sessionId={sessionId} record={lead} />;

  if (worker !== null)
    return <WorkerIntent hostKey={hostKey} sessionId={sessionId} worker={worker} />;

  return <SessionIntent hostKey={hostKey} sessionId={sessionId} />;
};

/** The `SessionOutput` slot: a Lead's Output has the Constellation tab first. */
export const ConstellationOutput = ({ hostKey, sessionId }: SessionSlot) => {
  const record = useLeadConstellation(hostKey, sessionId);
  const key = leadKey(hostKey, sessionId);
  const ui = useLeadUi(key);
  const commands = useCommands();
  const subagent = useShownSubagent(hostKey, sessionId) !== null;
  const browser = useBrowserUi(browserKey(hostKey, sessionId)).shown && !subagent;

  const workspaceId = useApp(
    (s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.workspaceId
  );

  const harness =
    useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.harness) ?? null;

  if (record === null) return <SessionOutput hostKey={hostKey} sessionId={sessionId} />;

  const pick = (tab: "constellation" | "changes") => {
    closeSubagent(hostKey, sessionId);
    leaveBrowser(hostKey, sessionId);
    patchLeadUi(key, () => ({ tab }));
  };

  const tabs = (
    <>
      <OutputTab
        id="constellation"
        on={!subagent && !browser && ui.tab === "constellation"}
        onClick={() => pick("constellation")}
      >
        Constellation
      </OutputTab>
      <OutputTab
        id="changes"
        on={!subagent && !browser && ui.tab === "changes"}
        onClick={() => pick("changes")}
      >
        Changes
      </OutputTab>
    </>
  );

  if (subagent || browser || ui.tab === "changes")
    return <SessionOutput hostKey={hostKey} sessionId={sessionId} tabs={tabs} />;

  return (
    <section
      aria-label="Output"
      className="bg-panel flex h-full min-h-0 min-w-0 flex-col"
      data-testid="session-output"
    >
      <div className="border-hairline flex h-11 shrink-0 items-center gap-1 border-b px-3">
        {tabs}
        <BrowserOutputTab hostKey={hostKey} sessionId={sessionId} on={false} harness={harness} />
        <span className="flex-1" />
        {ui.focus?.kind === "task" ? (
          <Button
            variant="secondary"
            onClick={() => {
              patchLeadUi(key, () => ({ focus: null, review: null }));
              commands.run("session.focusComposer");
            }}
          >
            Message lead
            <Kbd variant="plain">M</Kbd>
          </Button>
        ) : null}
        {workspaceId === undefined ? null : (
          <IconButton
            size="sm"
            label="Hide output"
            icon={<ChevronRightIcon size={14} />}
            onClick={() => hideOutput({ hostKey, workspaceId }, sessionId)}
          />
        )}
      </div>
      <ConstellationTab hostKey={hostKey} record={record} />
    </section>
  );
};
