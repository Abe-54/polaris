/**
 * The shell's slots: the views other features fill. The shell owns layout,
 * selection and keyboard; a feature owns what renders inside its slot. To
 * wire a feature in, replace its default below with the feature's component.
 */
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import type { ComponentType, ReactElement } from "react";
import { HostsSettingsPage } from "../features/machines/index.ts";
import { NeedsYouHover, NeedsYouInbox } from "../features/needs-you/index.ts";
import { NewSessionPage, OutputRail } from "../features/session/index.ts";
import { ConstellationIntent, ConstellationOutput } from "../features/constellation/index.ts";
import { WorkspaceStage } from "../features/empty/index.ts";
import { SessionList, type SessionListProps } from "../features/sessions/index.ts";
import { JumpMenu } from "../features/jump/index.ts";
import { OpenFolderDialog } from "../features/open-folder/index.ts";
import {
  HarnessTerminal,
  type HarnessTerminalProps,
  openShell,
  type TerminalPlace,
} from "../features/terminal/index.ts";
import { PullList, type PullListProps } from "../features/pulls/index.ts";
import { ReviewView, type ReviewViewProps } from "../features/review/index.ts";

/** A selected Agent Session: which Host it lives on and its id. */
export interface SessionSlotProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

/** A Workspace in context (new session, empty states). */
export interface WorkspaceSlotProps {
  readonly hostKey: string;
  readonly workspaceId: WorkspaceId;
}

export interface JumpMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export interface NewSessionProps extends WorkspaceSlotProps {
  /** Call once the session is started; the shell selects it. */
  readonly onStarted: (sessionId: SessionId) => void;
  readonly onCancel: () => void;
}

/** Wraps a session row or Workspace chip that needs you with its hover card. */
export interface NeedsYouHoverSlotProps {
  readonly hostKey: string;
  readonly sessionId?: SessionId;
  readonly workspaceId?: WorkspaceId;
  readonly children: ReactElement;
}

export interface SettingsHostsProps {
  /** Open the add-a-host form at once (`openSettings("hosts", { adding: true })`). */
  readonly adding: boolean;
}

export interface ShellSlots {
  /** The Intent column (the rest): the conversation and composer of the selected session. */
  readonly SessionIntent: ComponentType<SessionSlotProps>;
  /** The Output panel (resizable, right): Changes, Preview, Files, Risk for the selected session. */
  readonly SessionOutput: ComponentType<SessionSlotProps>;
  /** Output collapsed: the 240px rail of Workspace facts. */
  readonly OutputRail: ComponentType<SessionSlotProps>;
  /** Spans Intent and Output while the user starts a session in a Workspace. */
  readonly NewSession: ComponentType<NewSessionProps>;
  /** Spans Intent and Output when the Workspace has no session selected. */
  readonly NoSession: ComponentType<WorkspaceSlotProps>;
  /** The sidebar's session list for one Workspace: rows, and each Lead with its workers. */
  readonly SessionList: ComponentType<SessionListProps>;
  /** The sidebar's "Needs you" view, across every Host. */
  readonly NeedsYouInbox: ComponentType;
  /** The K jump menu; the shell owns its open state (`useShellActions().openJump`). */
  readonly JumpMenu: ComponentType<JumpMenuProps>;
  /** The ⌘O dialog (a folder on any Host); it reads its open state from navigation (`folder`). */
  readonly OpenFolder: ComponentType;
  /** The Needs You hover card around a waiting session's row or its Workspace chip. */
  readonly NeedsYouHover: ComponentType<NeedsYouHoverSlotProps>;
  /** Settings → Hosts (Paper S4): the page centres its own 680px column. */
  readonly SettingsHosts: ComponentType<SettingsHostsProps>;
  /** Settings → Harnesses' "Sign in in terminal": the Harness's own sign-in on its Host. */
  readonly HarnessTerminal: ComponentType<HarnessTerminalProps>;
  /** Review with no subject open: the pull request list (Paper R3, features/pulls). */
  readonly PullRequests: ComponentType<PullListProps>;
  /** Review of one subject, a pull request (R1) or an Agent Session's Turns (R2); from `routes/review.ts`. */
  readonly ReviewSubject: ComponentType<ReviewViewProps>;
  /** A Workspace's shell in its terminal drawer (the chip's "Open terminal here"). */
  readonly openTerminal: (place: TerminalPlace, cwd: string, title: string) => void;
}

// Getters, read at render: features import this module back, so at load a filler may not exist yet.
export const slots: ShellSlots = {
  get SessionIntent() {
    return ConstellationIntent;
  },
  get SessionOutput() {
    return ConstellationOutput;
  },
  get OutputRail() {
    return OutputRail;
  },
  get NewSession() {
    return NewSessionPage;
  },
  get NoSession() {
    return WorkspaceStage;
  },
  get SessionList() {
    return SessionList;
  },
  get NeedsYouInbox() {
    return NeedsYouInbox;
  },
  get JumpMenu() {
    return JumpMenu;
  },
  get OpenFolder() {
    return OpenFolderDialog;
  },
  get NeedsYouHover() {
    return NeedsYouHover;
  },
  get SettingsHosts() {
    return HostsSettingsPage;
  },
  get HarnessTerminal() {
    return HarnessTerminal;
  },
  get PullRequests() {
    return PullList;
  },
  get ReviewSubject() {
    return ReviewView;
  },
  openTerminal: (place, cwd, title) => void openShell(place, cwd, title),
};
