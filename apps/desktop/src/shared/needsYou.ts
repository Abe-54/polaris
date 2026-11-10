/**
 * What the renderer tells the main process about Needs You, for the menu bar star, the Dock
 * badge and native notifications, and what those send back. Plain data, types only.
 */

import type { ApprovalKind } from "@polaris/protocol";

/** One pending approval, question or Secret Request, as a notification shows it. */
export interface NeedsYouRequest {
  readonly requestId: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  /** Always null for a Secret Request: its reason stays in the session's card. */
  readonly detail: string | null;
  /** A question's numbered answers. */
  readonly options: ReadonlyArray<string>;
}

/** A session waiting on the user, on any Host. */
export interface NeedsYouSession {
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly workspace: string | null;
  readonly sessionId: string;
  readonly title: string;
  /** The Harness's name ("Claude Code"). */
  readonly harness: string;
  /** Approvals and questions, oldest first; empty for an Interrupted Turn waiting on Continue. */
  readonly requests: ReadonlyArray<NeedsYouRequest>;
}

/** A session mid-Turn or Idle, so main can tell when a Turn ends (Settings → Sessions). */
export interface NeedsYouTurn {
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly sessionId: string;
  readonly title: string;
  readonly harness: string;
  readonly state: "working" | "idle";
  /** The latest ended Turn's reply as plain text (`lastReplyPreview`); null: none, or an older Daemon. */
  readonly reply: string | null;
  /** Polaris started the latest Turn for a Constellation digest: not the user's Turn. */
  readonly digestStarted?: boolean;
  /** Live background tasks: an Idle session with any is waiting on them, not done. */
  readonly backgroundTasks: number;
  /** The Harness will start a Turn for finished tasks' reports (`backgroundReportsPending`). */
  readonly backgroundReportsPending?: boolean;
  /** The current user Turn: the Daemon's (`currentUserTurn`), else the latest seen live; or null. */
  readonly userTurn: Pick<UserTurn, "id" | "startedAt"> | null;
  /** When the session last changed, on its Host's clock: when it went Idle, at that summary. */
  readonly updatedAt: string;
  /** Set for a Reviewer's or walkthrough's own session: it notifies as its Review. */
  readonly review?: NeedsYouReview;
}

/** A Review as the Review view opens it: a pull request, or an Agent Session's Turns. */
export type ReviewTarget =
  | {
      readonly kind: "pull";
      readonly repo: { readonly owner: string; readonly name: string };
      readonly number: number;
      /** Its GitHub node id, when the pull request list has it. */
      readonly pullId: string | null;
    }
  | { readonly kind: "session"; readonly hostKey: string; readonly sessionId: string };

/** What a Reviewer's or walkthrough's session reviews, for its notification. */
export interface NeedsYouReview {
  readonly kind: "reviewer" | "walkthrough";
  /** The change: the pull request's title (else `owner/name #12`), or the Agent Session's title. */
  readonly change: string;
  /** The Review a click opens; null when the Client can't tell which. */
  readonly target: ReviewTarget | null;
  /** Open findings of this run's finished Risk Summary, when the Client has it; else null. */
  readonly findings: { readonly open: number; readonly critical: number } | null;
}

/** A Turn the user prompted: Turns the Harness starts afterwards continue it. */
export interface UserTurn {
  readonly id: string;
  readonly startedAt: string;
  /** Its prompt, shortened. */
  readonly prompt: string;
}

/** The latest notification an agent sent from a session (MCP `notify`). */
export interface NeedsYouNotification {
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  /** The notification's own id: each is shown once. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Polaris sent it because a Constellation needs you, not the agent (Settings → Sessions). */
  readonly automatic?: boolean;
  /** The Constellation it is about; a click opens the Constellation view then. */
  readonly constellationId?: string | null;
}

export interface NeedsYouSummary {
  /** Sessions that need you across every Host: the menu bar and Dock count. */
  readonly count: number;
  readonly sessions: ReadonlyArray<NeedsYouSession>;
  /** The session the window shows; no notification for it while the window is focused. */
  readonly focused: { readonly hostKey: string; readonly sessionId: string } | null;
  /** Working and Idle sessions outside Constellations, for Turn notifications; none if absent. */
  readonly turns?: ReadonlyArray<NeedsYouTurn>;
  /** Each session's latest agent notification; none if absent. */
  readonly notifications?: ReadonlyArray<NeedsYouNotification>;
  /** The Review the window shows; no Review notification for it while the window is focused. */
  readonly reviewing?: ReviewTarget | null;
}

/** What the menu bar and notifications ask the renderer to do. */
export type NeedsYouAction =
  | { readonly action: "open"; readonly hostKey: string; readonly sessionId: string }
  /** The Lead's session with its Constellation view in front. */
  | { readonly action: "open-constellation"; readonly hostKey: string; readonly sessionId: string }
  | {
      readonly action: "approve" | "deny";
      readonly hostKey: string;
      readonly sessionId: string;
      readonly requestId: string;
    }
  | {
      readonly action: "answer";
      readonly hostKey: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly text: string;
    };
