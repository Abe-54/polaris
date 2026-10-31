/**
 * The shell's command handlers (ids in `shared/keymap.ts`): views, the jump
 * menu and shortcut help, moving between sessions, and the selected
 * session's actions. Session actions use the session feature's command
 * builders and reach its composer through its test id, without editing it.
 */
import type { SessionId } from "@polaris/protocol";
import { Commands, Decisions } from "../commands.ts";
import { harnessBackgroundsCommands } from "../features/harness/index.ts";
import { runInBackground, send } from "../features/session/dispatch.ts";
import { foregroundCommands } from "../features/session/model/running.ts";
import { toggleOutput } from "../features/session/index.ts";
import { archiveCommand, interruptCommand } from "../features/session/model/intent.ts";
import type { ContextKey, ContextValue } from "../../shared/keymap.ts";
import type { CommandHandlers, ContextPart } from "../routes/commands.ts";
import type { Navigation } from "../routes/navigation.ts";
import { type Selection, type SessionSort, sessionOrder } from "../routes/selection.ts";
import { byTier, tierOf } from "../features/sessions/model/tiers.ts";
import { activeSessions, shownWorkspaces } from "../routes/topBar.ts";
import type { SessionEntry } from "../store/hostModel.ts";
import { setAppearance, setSessionPrefs, settingsStore } from "../features/settings/index.ts";
import { type AppState, type Connection, sessionKey } from "../store/store.ts";
import { workspaceList } from "./visibility.ts";

const ordered = (entries: ReadonlyArray<SessionEntry>, sort: SessionSort) =>
  sort === "active" ? byTier(entries, tierOf) : entries;

/** The sessions the sidebar lists, in its order: ⌘⌥↑/↓ walk them. */
export const sidebarSessions = (
  selection: Selection,
  app: AppState,
  sort: SessionSort = "newest"
): ReadonlyArray<SessionEntry> => {
  const model = selection.hostKey === null ? undefined : app.hostModels[selection.hostKey];

  if (model === undefined) return [];

  if (selection.topBar === "workspaces") {
    return selection.workspaceId === null
      ? []
      : ordered([...activeSessions(model, selection.workspaceId)].sort(sessionOrder), sort);
  }

  return shownWorkspaces(model).flatMap((w) => [...activeSessions(model, w.id)].sort(sessionOrder));
};

/** The session `step` rows away from the selected one, wrapping around. */
export const stepSession = (
  list: ReadonlyArray<SessionEntry>,
  current: SessionId | null,
  step: number
): SessionEntry | undefined => {
  if (list.length === 0) return undefined;
  const at = list.findIndex((e) => e.session.id === current);

  if (at === -1) return step > 0 ? list[0] : list.at(-1);

  return list[(at + step + list.length) % list.length];
};

/** The shell's facts for `when` conditions and titles: the selected Workspace and session. */
export const shellContext =
  ({ connection, navigation }: Omit<ShellCommandsInput, "dark">) =>
  (): ContextPart => {
    const { hostKey, workspaceId, sessionId, mode, topBar } = navigation.current();
    const model = hostKey === null ? undefined : connection.store.getState().hostModels[hostKey];
    const workspace = workspaceId === null ? undefined : model?.workspaces.get(workspaceId)?.name;
    const session = sessionId === null ? undefined : model?.sessions.get(sessionId)?.session;

    const values: Partial<Record<ContextValue, string>> = { workspaceList: workspaceList(topBar) };

    if (workspace !== undefined) values.workspace = workspace;

    if (session !== undefined) values.session = session.title || "Untitled session";

    const keys: Array<ContextKey> = workspace === undefined ? [] : ["workspace"];

    if (mode === "edit") keys.push("mode.edit");

    if (mode === "data") keys.push("mode.data");

    return { keys, values };
  };

export interface ShellCommandsInput {
  readonly connection: Connection;
  readonly navigation: Navigation;
  /** Whether the window is dark right now (the theme toggle flips it). */
  readonly dark: () => boolean;
}

const COMPOSER = '[data-testid="composer-input"]';

export const shellCommands = ({
  connection,
  navigation,
  dark,
}: ShellCommandsInput): CommandHandlers => {
  const { actions } = navigation;
  const app = () => connection.store.getState();

  const selected = () => {
    const { hostKey, sessionId } = navigation.current();

    if (hostKey === null || sessionId === null) return null;
    const entry = app().hostModels[hostKey]?.sessions.get(sessionId);

    return entry === undefined ? null : { hostKey, entry };
  };

  const step = (by: number) => () => {
    const selection = navigation.current();
    const listed = sidebarSessions(selection, app(), navigation.store.getState().sessionSort);

    const next = stepSession(listed, selection.sessionId, by);

    if (next !== undefined && selection.hostKey !== null) {
      actions.selectSession({ hostKey: selection.hostKey, sessionId: next.session.id });
    }
  };

  const lastTurn = (hostKey: string, entry: SessionEntry) =>
    app().sessions[sessionKey(hostKey, entry.session.id)]?.turns.at(-1)?.turn.status ??
    (entry.session.state === "working" ? "working" : null);

  const interrupt = () => {
    const s = selected();

    return s === null ? null : interruptCommand(s.entry.session.id, lastTurn(s.hostKey, s.entry));
  };

  const answer = (approve: boolean) => () => {
    const s = selected();
    const request = s?.entry.pendingApprovals[0];

    // A Secret Request is answered only in its card, never approved or denied from a shortcut.
    if (s === null || request === undefined || request.kind === "secret") return;

    const decision = approve
      ? Decisions.Allow({ remember: false })
      : Decisions.Deny({ reason: null });

    void send(
      s.hostKey,
      Commands.RespondToApproval({
        sessionId: s.entry.session.id,
        requestId: request.id,
        decision,
      }),
      "Couldn't answer"
    );
  };

  /** Ctrl-B, as in Claude Code: only while the session's Turn waits on a command it can move. */
  const backgroundable = () => {
    const s = selected();

    if (s === null) return null;
    const { id, harness } = s.entry.session;
    const host = app().hosts.find((h) => h.key === s.hostKey);
    const turn = app().sessions[sessionKey(s.hostKey, id)]?.turns.at(-1);

    return host?.status.capabilities.includes("session.background-command") === true &&
      harnessBackgroundsCommands(s.hostKey, harness) &&
      foregroundCommands(turn).length > 0
      ? { hostKey: s.hostKey, sessionId: id }
      : null;
  };

  const hasApproval = () => {
    const first = selected()?.entry.pendingApprovals[0];

    return first !== undefined && first.kind !== "secret";
  };

  return {
    "view.orchestrate": { run: () => actions.setMode("orchestrate") },
    "view.review": { run: () => actions.setMode("review") },
    "view.edit": { run: () => actions.setMode("edit") },
    "view.data": { run: () => actions.setMode("data") },
    "view.wordWrap": {
      run: () => setAppearance({ wordWrap: !settingsStore.getState().appearance.wordWrap }),
    },
    "view.output": {
      run: () => {
        const s = selected();

        if (s !== null) {
          const { id, workspaceId } = s.entry.session;

          toggleOutput({ hostKey: s.hostKey, workspaceId }, id);
        }
      },
      enabled: () => selected() !== null,
    },
    "jump.open": { run: actions.openJump },
    "palette.open": { run: () => actions.setPaletteOpen(true) },
    "help.shortcuts": { run: () => actions.setHelpOpen(true) },
    "session.new": {
      run: actions.startNewSession,
      // With no Workspace, onboarding starts it in the Host's home directory.
      enabled: () => navigation.current().hostKey !== null,
    },
    "session.next": { run: step(1) },
    "session.previous": { run: step(-1) },
    "navigation.back": { run: actions.back, enabled: actions.canGoBack },
    "navigation.forward": { run: actions.forward, enabled: actions.canGoForward },
    "session.focusComposer": {
      run: () => document.querySelector<HTMLElement>(COMPOSER)?.focus(),
      enabled: () => document.querySelector(COMPOSER) !== null,
    },
    "session.interrupt": {
      run: () => {
        const s = selected();
        const command = interrupt();

        if (s !== null && command !== null) void send(s.hostKey, command, "Couldn't stop");
      },
      enabled: () => interrupt() !== null,
    },
    "session.background": {
      run: () => {
        const target = backgroundable();

        if (target !== null) void runInBackground(target.hostKey, target.sessionId, null);
      },
      enabled: () => backgroundable() !== null,
    },
    "approval.approve": { run: answer(true), enabled: hasApproval },
    "approval.deny": { run: answer(false), enabled: hasApproval },
    "session.archive": {
      run: () => {
        const s = selected();

        if (s !== null)
          void send(
            s.hostKey,
            archiveCommand(
              s.entry.session.id,
              settingsStore.getState().sessions.deleteMergedBranch
            ),
            "Couldn't archive"
          );
      },
      enabled: () => selected() !== null,
    },
    "session.openInTerminal": {
      run: () => {
        const s = selected();

        if (s !== null) {
          void send(
            s.hostKey,
            Commands.OpenInTerminal({ sessionId: s.entry.session.id }),
            "Couldn't open in terminal"
          );
        }
      },
      enabled: () => {
        const s = selected();
        const host = s === null ? undefined : app().hosts.find((h) => h.key === s.hostKey);

        return (
          s !== null &&
          s.entry.session.state !== "in-terminal" &&
          (host?.status.capabilities.includes("session.terminal-handoff") ?? false)
        );
      },
    },
    "workspace.add": {
      // The ⌘O dialog, on the selected Host; any Host can be picked in it.
      run: () => actions.openFolder(navigation.current().hostKey),
      enabled: () => app().hosts.length > 0,
    },
    "tab.close": { run: () => window.close() },
    "window.close": { run: () => window.close() },
    "editor.toggleInlineDiagnostics": {
      run: () =>
        setSessionPrefs({
          editorInlineDiagnostics: !settingsStore.getState().sessions.editorInlineDiagnostics,
        }),
    },
    "theme.toggle": {
      run: () =>
        void window.polaris.request("settings.setTheme", { theme: dark() ? "light" : "dark" }),
    },
  };
};
