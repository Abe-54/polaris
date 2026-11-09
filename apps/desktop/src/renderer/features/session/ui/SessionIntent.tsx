/**
 * The Intent column for one Agent Session (Paper artboard 5): its header, the
 * live conversation and the composer. Output (the Turn's diff) is separate so
 * the shell can place the two regions.
 */
import {
  type ApprovalDecision,
  type ApprovalRequest,
  isKnownHarness,
  type SessionId,
} from "@polaris/protocol";
import { type Harness, sessionCelestial } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Commands } from "../../../commands.ts";
import { emptyHostModel } from "../../../store/hostModel.ts";
import type { SessionData } from "../../../store/plain.ts";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { isWindowsHost } from "../../../shell/hostPlatform.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { modelLabel, useHarnessModels } from "../../harness/index.ts";
import { InTerminalBar } from "../../terminal/index.ts";
import { send } from "../dispatch.ts";
import { useHost, useSession, hasCapability } from "../hooks.ts";
import { waitingFor } from "../model/background.ts";
import { subagentRoster } from "../model/subagents.ts";
import { openSubagent } from "../output/actions.ts";
import { conversationRows } from "../model/conversation.ts";
import { copyableOutput, groupOf, groupTurns, turnNumber } from "../model/turnGroups.ts";
import { copyWithToast } from "../../../shell/menu/index.ts";
import { tildePath } from "../model/format.ts";
import {
  composerMode,
  continueCommand,
  openQuestion,
  resumeAtResetCommand,
  retryCommand,
} from "../model/intent.ts";
import { useLeadConstellation } from "../../constellation/hooks.ts";
import { useOutbox } from "../outbox.ts";
import { useSessionContinuity } from "../continuity.ts";
import { useForkRequest } from "../forkRequest.ts";
import { holdOpenFrom, setTurnOpen, showTurnDiff, uiKey, useSessionUi } from "../state.ts";
import { ForkDialog, type ForkTarget } from "./ForkDialog.tsx";
import type { RowContext } from "./rows.tsx";
import { SessionComposer } from "./SessionComposer.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { Transcript } from "./Transcript.tsx";
import { useSessionChrome } from "../chrome.ts";
import { EditorPlaceProvider } from "../../editor-links/index.ts";

/** The shell's session slot props (`app/slots.tsx`). */
export interface SessionViewProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

const useWhere = (hostKey: string, session: SessionData | null) => {
  const host = useHost(hostKey);
  const model = useApp((s) => s.hostModels[hostKey]) ?? emptyHostModel;

  if (session === null) return { where: "", branch: undefined };
  const workspace = model.workspaces.get(session.workspaceId);
  const worktree = session.worktreeId === null ? null : model.worktrees.get(session.worktreeId);
  const path = tildePath(session.cwd, host?.status.host?.homeDir ?? null);
  const parts = [host?.label, workspace?.name, path].filter((p) => p !== undefined);

  return { where: parts.join(" · "), branch: worktree?.branch ?? undefined };
};

/** A folded Turn's Copy: every reply across it, as Copy turn output does. */
const copyTurnOutput = (turns: SessionModel["turns"], turnId: string) => {
  const group = groupOf(groupTurns(turns), turnId);
  const output = group === undefined ? null : copyableOutput(group, null, false);

  if (output !== null) copyWithToast(output, "turn output");
};

/** The Turn a fork starts from: the one asked for, else the latest finished. */
const forkFrom = (
  turns: SessionModel["turns"],
  turnId: string | undefined,
  lastDone: SessionModel["turns"][number]["turn"] | undefined
) => (turnId === undefined ? lastDone : turns.find((t) => t.turn.id === turnId)?.turn);

const forkAction = (canFork: boolean, start: (turnId: string) => void) => (canFork ? start : null);

const Placeholder = ({ children }: { readonly children: string }) => (
  <section className="text-body text-text-subtle grid flex-1 place-items-center">
    {children}
  </section>
);

export const SessionIntent = ({ hostKey, sessionId }: SessionViewProps) => {
  const { selectSession } = useShellActions();
  // A Fork opens once it exists; the shell owns selection.
  const onOpenSession = (id: SessionId) => selectSession({ hostKey, sessionId: id });
  const model = useSession(hostKey, sessionId);
  const key = uiKey(hostKey, sessionId);
  const ui = useSessionUi(key);
  const host = useHost(hostKey);
  const { where, branch } = useWhere(hostKey, model.session);
  const [forking, setForking] = useState<ForkTarget | null>(null);
  const chrome = useSessionChrome();
  const models = useHarnessModels(hostKey, model.session?.harness ?? "", model.session !== null);
  const { session } = model;
  const latestId = model.turns.at(-1)?.turn.id;

  // The latest Turn when the session is first shown, so later Turns never fold it.
  useEffect(() => {
    if (latestId !== undefined) holdOpenFrom(key, latestId);
  }, [key, latestId]);

  const mode =
    session === null
      ? null
      : composerMode({
          state: session.state,
          lastTurn: model.turns.at(-1)?.turn.status ?? null,
          pendingApprovals: model.pendingApprovals.length,
          question: openQuestion(model.pendingApprovals),
          canSteer: hasCapability(host, "session.steer"),
        });

  const outbox = useOutbox({
    hostKey,
    uiKey: key,
    sessionId,
    model,
    ready: mode?.kind === "send",
    canSteer: mode?.kind === "steer",
  });

  const lastDone = model.turns.findLast((t) => t.turn.status !== "working")?.turn;

  useSessionContinuity({
    hostKey,
    sessionId,
    enabled: hasCapability(host, "session.continuity"),
    lastEnded: lastDone?.id ?? null,
  });
  const forkHarness = session !== null && isKnownHarness(session.harness) ? session.harness : null;

  const canFork =
    forkHarness !== null && lastDone !== undefined && hasCapability(host, "session.fork");

  const startFork = (turnId?: string): boolean => {
    const from = forkFrom(model.turns, turnId, lastDone);

    if (session === null || forkHarness === null || from === undefined) return false;
    setForking({
      sessionId,
      turnId: from.id,
      turnNumber: turnNumber(model.turns, from.id) ?? from.index + 1,
      harness: forkHarness,
      model: session.model,
      effort: session.effort,
    });

    return true;
  };

  useForkRequest(key, () => canFork && startFork());
  const lead = useLeadConstellation(hostKey, sessionId) !== null;

  if (session === null) return <Placeholder>Loading the session…</Placeholder>;
  const harness: Harness | null = forkHarness;
  const lastTurn = model.turns.at(-1)?.turn ?? null;

  const listed = conversationRows({
    setup: session.worktreeSetup,
    turns: model.turns,
    approvals: model.pendingApprovals,
    settledSecrets: model.settledSecrets ?? [],
    settledWrites: model.settledWrites ?? [],
    folds: ui.folds,
    outbox: ui.outbox,
    waiting: waitingFor(
      session,
      subagentRoster(model.turns),
      hasCapability(host, "session.subagents")
    ),
  });

  const rows =
    chrome.trailer === undefined
      ? listed
      : [...listed, { kind: "trailer" as const, key: "trailer" }];

  const ctx: Omit<RowContext, "onLoadOlder"> = {
    harness,
    celestial: sessionCelestial(session.celestial, lead),
    state: session.state,
    liveTurnId: lastTurn?.status === "working" && session.state === "working" ? lastTurn.id : null,
    where,
    diff: { hostKey, cwd: session.cwd, sessionId },
    onSetTurnOpen: (turnId, open) => setTurnOpen(key, turnId, open),
    onOpenDiff: (turnId) => showTurnDiff(key, turnId),
    onOpenSubagent: (id) =>
      openSubagent({ hostKey, workspaceId: session.workspaceId }, sessionId, id),
    onRespond: (request: ApprovalRequest, decision: ApprovalDecision) =>
      void send(
        hostKey,
        Commands.RespondToApproval({ sessionId, requestId: request.id, decision }),
        "Couldn't answer"
      ),
    onContinue: () => void send(hostKey, continueCommand(sessionId), "Couldn't continue"),
    limit:
      session.state === "limited"
        ? {
            resetsAt: session.limitResetsAt ?? null,
            resumeAtReset: session.resumeAtReset,
            onSetResumeAtReset: (on) =>
              void send(
                hostKey,
                resumeAtResetCommand(sessionId, on),
                on ? "Couldn't turn on Resume at reset" : "Couldn't turn off Resume at reset"
              ),
          }
        : null,
    onRetry: () => void send(hostKey, retryCommand(sessionId), "Couldn't retry"),
    modelLabel: (model, effort) => modelLabel(models.models, model, effort),
    canSteer: mode?.kind === "steer",
    outbox,
    chrome,
    latestDoneTurnId: lastDone?.id ?? null,
    onCopyTurn: (turnId) => copyTurnOutput(model.turns, turnId),
    onForkTurn: forkAction(canFork, (turnId) => void startFork(turnId)),
  };

  const place = {
    hostKey,
    root: session.cwd,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    windows: isWindowsHost(host),
  };

  return (
    <EditorPlaceProvider value={place}>
      <section
        aria-label={session.title}
        data-testid="session-panel"
        className="bg-panel flex h-full min-h-0 min-w-0 flex-col"
      >
        {chrome.header ?? (
          <SessionHeader
            hostKey={hostKey}
            session={session}
            harness={harness}
            turnNumber={lastTurn === null ? null : turnNumber(model.turns, lastTurn.id)}
            canFork={canFork}
            onFork={() => void startFork()}
            branch={branch}
          />
        )}
        {chrome.body ?? (
          <Transcript
            uiKey={key}
            hostKey={hostKey}
            sessionId={sessionId}
            canPage={hasCapability(host, "session.turn-paging")}
            turns={model.turns}
            rows={rows}
            ctx={ctx}
          />
        )}
        <InTerminalBar
          session={{
            hostKey,
            workspaceId: session.workspaceId,
            sessionId,
            state: session.state,
            title: session.title === "" ? session.harness : session.title,
          }}
        />
        {harness === null ? null : (
          <SessionComposer
            hostKey={hostKey}
            uiKey={key}
            harness={harness}
            session={session}
            model={model}
            branch={branch}
            onOpenSession={onOpenSession}
            outbox={outbox}
          />
        )}
        <ForkDialog
          hostKey={hostKey}
          target={forking}
          onClose={() => setForking(null)}
          onForked={onOpenSession}
        />
      </section>
    </EditorPlaceProvider>
  );
};
