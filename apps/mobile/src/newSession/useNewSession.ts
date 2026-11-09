/**
 * A new session's state (Paper MX-AO): where it runs, the draft kept for that place, the Harness,
 * Model and permission mode, New worktree, and the first send, which creates the session.
 */
import { type SessionId, type Workspace, WorkspaceId } from "@polaris/protocol";
import { useMemo, useState } from "react";
import { useAttachments } from "../composer/useAttachments.ts";
import { useVoiceInput } from "../composer/useVoiceInput.ts";
import type { HostConnection } from "../runtime/hostConnection.ts";
import type { NewSessionApi } from "./api.ts";
import { type Draft, type DraftStore, useDraft } from "./draft.ts";
import { startLatch, takePrompt } from "./latch.ts";
import {
  branchFromPrompt,
  defaultTarget,
  failureText,
  newSessionId,
  type RecentChip,
  recentChips,
  type SheetHost,
  type StartChoices,
  startCommand,
  type Target,
  worktreeCaption,
} from "./model.ts";
import {
  type PermissionChoice,
  type PermissionModeStore,
  usePermissionChoice,
} from "./permissionModes.ts";
import { type HarnessChoice, useHarnessChoice } from "./useHarnessChoice.ts";

export interface NewSessionInput {
  readonly hosts: ReadonlyArray<SheetHost>;
  readonly api: NewSessionApi;
  /** Opens on this Workspace (and its Host) instead of the last used one. */
  readonly workspaceId?: string;
  /** Opens on this Host (ENG-494): its last used Workspace, else its first. */
  readonly hostId?: string;
  /** The Host's connection, for Attach and the mic; without it neither is offered. */
  readonly connectionFor: (hostId: string) => HostConnection | null;
  readonly onStarted: (hostId: string, sessionId: string) => void;
  readonly draftStore?: DraftStore;
  readonly permissionModeStore?: PermissionModeStore;
}

export interface NewSession {
  readonly target: Target | null;
  readonly host: SheetHost | null;
  readonly workspace: Workspace | null;
  readonly pick: (target: Target) => void;
  readonly recents: ReadonlyArray<RecentChip>;
  readonly draft: Draft;
  readonly choice: HarnessChoice;
  readonly permission: PermissionChoice;
  readonly newWorktree: boolean;
  readonly setNewWorktree: (on: boolean) => void;
  /** "On: works on polaris/…" or "Off: runs in ~/code/polaris, in place"; null without a workspace. */
  readonly worktreeCaption: string | null;
  readonly attachments: ReturnType<typeof useAttachments>;
  readonly voice: ReturnType<typeof useVoiceInput>;
  /** Why Send is off ("" when the prompt is only empty); null when it can send. */
  readonly why: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly send: () => Promise<void>;
}

/** The Harness's state as one sentence while nothing can start; null once one can. */
const harnessBlocker = (choice: HarnessChoice): string | null => {
  if (choice.load.kind === "failed") return `Couldn't check harnesses: ${choice.load.message}`;

  if (choice.load.kind === "loading") return "Checking harnesses…";

  return choice.harness === null ? "No harness is ready on this host" : null;
};

const sendBlocker = (host: SheetHost | null, prompt: string, choice: HarnessChoice) => {
  if (host === null) return "Add a workspace on the Mac first";

  if (!host.connected) return `${host.hostName} isn't connected`;

  return harnessBlocker(choice) ?? (prompt.trim() === "" ? "" : null);
};

export const useNewSession = (input: NewSessionInput): NewSession => {
  const { hosts, api } = input;
  const [picked, setPicked] = useState<Target | null>(null);
  const target = picked ?? defaultTarget(hosts, input.workspaceId, input.hostId);
  const host = hosts.find((h) => h.hostId === target?.hostId) ?? null;
  const workspace = host?.workspaces.find((w) => w.id === target?.workspaceId) ?? null;
  const draft = useDraft(target, input.draftStore);
  const choice = useHarnessChoice(api, host);
  const permission = usePermissionChoice(host, input.permissionModeStore);
  const [newWorktree, setNewWorktree] = useState(false);
  // Chosen up front so the branch the caption shows is the one the session gets.
  const [sessionId] = useState<SessionId>(newSessionId);
  const [latch] = useState(() => startLatch());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = target === null ? null : input.connectionFor(target.hostId);

  const stageTarget = useMemo(
    () =>
      connection === null || target === null
        ? null
        : { connection, workspaceId: WorkspaceId.make(target.workspaceId), sessionId: null },
    [connection, target?.workspaceId]
  );

  const attachments = useAttachments(stageTarget);
  const voice = useVoiceInput({ connection, text: draft.text, onText: draft.setText });
  const staging = attachments.staging ? "Attaching files…" : null;
  const why = sendBlocker(host, draft.text, choice) ?? staging;
  const gitRepo = workspace?.isGitRepo ?? false;

  const send = async () => {
    if (why !== null || target === null || choice.harness === null) return;

    const choices: StartChoices = {
      sessionId,
      workspaceId: WorkspaceId.make(target.workspaceId),
      harness: choice.harness,
      model: choice.model?.id ?? null,
      effort: choice.model === null ? null : choice.effort,
      prompt: takePrompt(voice, () => draft.text),
      newWorktree: newWorktree && gitRepo,
      permissionMode: permission.mode,
      capabilities: host?.capabilities ?? [],
      attachments: attachments.ids,
    };

    try {
      const sent = await latch(JSON.stringify(choices), async (commandId) => {
        setBusy(true);
        setError(null);
        await api.dispatch(target.hostId, commandId, startCommand(choices));
      });

      if (!sent) return;
      permission.keep();
      attachments.clear();
      await draft.clear();
      input.onStarted(target.hostId, sessionId);
    } catch (failure) {
      setError(`Couldn't start the session: ${failureText(failure)}`);
      setBusy(false);
    }
  };

  return {
    target,
    host,
    workspace,
    pick: setPicked,
    recents: recentChips(hosts, target),
    draft,
    choice,
    permission,
    newWorktree: newWorktree && gitRepo,
    setNewWorktree,
    worktreeCaption:
      workspace === null
        ? null
        : worktreeCaption(
            newWorktree && gitRepo,
            workspace,
            host?.homeDir ?? null,
            branchFromPrompt(draft.text, sessionId)
          ),
    attachments,
    voice,
    why,
    busy,
    error,
    send,
  };
};
