/**
 * The long-press menus (ENG-490): the Desktop App's right-click menus for the same items, cut to
 * what a Linked Device may send (`DEVICE_COMMANDS`) and what means something on a phone.
 */
import {
  type ApprovalRequest,
  Command,
  type ConnectionState,
  ConstellationId,
  SessionId,
  SetConstellationStateAction,
} from "@polaris/protocol";
import type { Session } from "../home/feed/fold.ts";
import type { ConstellationRow, SessionRow } from "../home/model/home.ts";
import { Match } from "effect";
import { approvalDetail } from "../home/model/lines.ts";
import { type Reply, respondCommand } from "../home/model/respond.ts";

export type MenuAction =
  | { readonly kind: "open-session"; readonly hostId: string; readonly sessionId: string }
  | { readonly kind: "open-review"; readonly hostId: string; readonly sessionId: string }
  | {
      readonly kind: "open-constellation";
      readonly hostId: string;
      readonly constellationId: string;
    }
  | {
      readonly kind: "reply";
      readonly hostId: string;
      readonly approval: ApprovalRequest;
      readonly reply: Reply;
    }
  | { readonly kind: "copy"; readonly text: string }
  /** A Command for the Host; a refusal alerts with `failure` as its title. */
  | {
      readonly kind: "send";
      readonly hostId: string;
      readonly command: Command;
      readonly failure: string;
    }
  /** Ask for a new title, then send RenameSession. */
  | {
      readonly kind: "rename";
      readonly hostId: string;
      readonly sessionId: string;
      readonly title: string;
    }
  /** A constellation's lifecycle action, sent as `constellation.set_state`. */
  | {
      readonly kind: "set-state";
      readonly hostId: string;
      readonly constellationId: ConstellationId;
      readonly action: SetConstellationStateAction;
      readonly failure: string;
    }
  | { readonly kind: "retry-host"; readonly hostId: string }
  /** The New agent session sheet, opened on this Host. */
  | { readonly kind: "new-session"; readonly hostId: string }
  /** Fork the session from a Turn: the Desktop App's; a Linked Device can't send ForkSession yet. */
  | {
      readonly kind: "fork";
      readonly hostId: string;
      readonly sessionId: string;
      readonly turnId: string;
    };

export interface MenuItem {
  /** Unique within its menu: what the native menu hands back when it is chosen. */
  readonly id: string;
  readonly title: string;
  /** Under the title; says why a disabled item is disabled. */
  readonly subtitle: string | null;
  readonly disabled: boolean;
  /** An SF Symbol drawn at the item's trailing edge, as MX-J draws Copy and Fork; null for none. */
  readonly symbol: string | null;
  readonly action: MenuAction;
}

/** Groups of items; the native menu draws a separator between groups. */
export type Menu = ReadonlyArray<ReadonlyArray<MenuItem>>;

const item = (id: string, title: string, action: MenuAction): MenuItem => ({
  id,
  title,
  subtitle: null,
  disabled: false,
  symbol: null,
  action,
});

/** Reviewer and walkthrough sessions, as the Desktop App's sidebar tells them apart. */
const isReviewSession = (session: Session) =>
  session.origin != null ||
  /[/\\]\.review[/\\]/u.test(session.cwd) ||
  session.title.startsWith("Reviewer · ") ||
  session.title.startsWith("Walkthrough · ");

/** The Desktop App's "Open in Review": the session has Turns of its own to review. */
export const reviewable = (session: Session) => session.turnCount > 0 && !isReviewSession(session);

const opens = (hostId: string, session: Session): ReadonlyArray<MenuItem> => [
  item("open-session", "Open agent session", {
    kind: "open-session",
    hostId,
    sessionId: session.id,
  }),
  ...(reviewable(session)
    ? [item("open-review", "Open review", { kind: "open-review", hostId, sessionId: session.id })]
    : []),
];

const copyId = (session: Session): MenuItem =>
  item("copy-id", "Copy agent session ID", { kind: "copy", text: session.id });

const ANSWERS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly reply: Reply;
}> = [
  { id: "approve", title: "Approve", reply: { kind: "approve" } },
  { id: "always", title: "Always here", reply: { kind: "always" } },
  { id: "deny", title: "Deny", reply: { kind: "deny" } },
];

/**
 * A permission request's answers, as the Needs You card's menu offers them. A question is
 * answered in words, a secret and a command too long to show inline only in the agent session.
 */
const answers = (row: SessionRow): ReadonlyArray<MenuItem> => {
  const { approval } = row;

  if (approval === null || approval.kind === "question" || approval.kind === "secret") return [];

  if (approvalDetail(approval)?.tooLong === true) return [];

  return ANSWERS.map(({ id, title, reply }) => ({
    ...item(id, title, { kind: "reply", hostId: row.hostId, approval, reply }),
    subtitle: row.stale ? "Host offline" : null,
    disabled: row.stale,
  }));
};

/** Needs You with nothing pending: a Turn the Daemon's restart interrupted, waiting on Continue. */
const interrupted = (row: SessionRow) => row.session.state === "needs-you" && row.approval === null;

/** What brings a stopped Turn back: Retry a Failed one, Continue an Interrupted one, or nothing. */
const recovery = (row: SessionRow): readonly [string, string, Command] | null => {
  const sessionId = SessionId.make(row.session.id);

  if (row.session.state === "failed")
    return ["retry", "Retry", Command.cases.Retry.make({ sessionId })];

  return interrupted(row)
    ? ["continue", "Continue", Command.cases.Continue.make({ sessionId })]
    : null;
};

/** The Desktop App's Retry and Continue (ENG-494), disabled while the Host is offline. */
const recovers = (row: SessionRow): ReadonlyArray<MenuItem> => {
  const offer = recovery(row);

  if (offer === null) return [];
  const [id, title, command] = offer;

  return [
    {
      ...item(id, title, {
        kind: "send",
        hostId: row.hostId,
        command,
        failure: `Couldn't ${title.toLowerCase()}`,
      }),
      subtitle: row.stale ? "Host offline" : null,
      disabled: row.stale,
    },
  ];
};

/**
 * The Desktop App's Pin, Rename and Archive. A phone's Archive keeps the branch
 * (`DEVICE_COMMANDS`), so Unarchive always undoes it.
 */
const manages = (hostId: string, session: Session): ReadonlyArray<MenuItem> => {
  const pinned = session.pinnedAt != null;
  const archived = session.state === "archived";
  const sessionId = session.id;

  return [
    item("pin", pinned ? "Unpin" : "Pin to top", {
      kind: "send",
      hostId,
      command: Command.cases.PinSession.make({ sessionId, pinned: !pinned }),
      failure: pinned ? "Couldn't unpin" : "Couldn't pin",
    }),
    item("rename", "Rename…", { kind: "rename", hostId, sessionId, title: session.title }),
    item("archive", archived ? "Unarchive" : "Archive", {
      kind: "send",
      hostId,
      command: archived
        ? Command.cases.UnarchiveSession.make({ sessionId })
        : Command.cases.ArchiveSession.make({ sessionId, deleteMergedBranch: false }),
      failure: archived ? "Couldn't unarchive" : "Couldn't archive",
    }),
  ];
};

/** An agent session's row on Home or in the Review tab. */
export const sessionMenu = (row: SessionRow): Menu =>
  [
    opens(row.hostId, row.session),
    answers(row),
    recovers(row),
    manages(row.hostId, row.session),
    [copyId(row.session)],
  ].filter((group) => group.length > 0);

const A = SetConstellationStateAction.cases;

/** The lifecycle actions the Daemon takes in each state, as the Desktop App names them. */
const LIFECYCLE: Readonly<
  Record<
    ConstellationRow["constellation"]["state"],
    ReadonlyArray<readonly [string, string, SetConstellationStateAction]>
  >
> = {
  planning: [],
  running: [
    ["pause", "Pause", A.Pause.make({})],
    ["complete", "Complete", A.Complete.make({})],
  ],
  paused: [
    ["resume", "Resume", A.Resume.make({})],
    ["complete", "Complete", A.Complete.make({})],
  ],
  completed: [["archive", "Archive", A.Archive.make({})]],
  archived: [],
};

const lifecycle = (row: ConstellationRow): ReadonlyArray<MenuItem> =>
  LIFECYCLE[row.constellation.state].map(([id, title, action]) =>
    item(id, title, {
      kind: "set-state",
      hostId: row.hostId,
      constellationId: ConstellationId.make(row.constellation.id),
      action,
      failure: `Couldn't ${title.toLowerCase()}`,
    })
  );

/** A constellation's row: the constellation, then its lead's own items. */
export const constellationMenu = (row: ConstellationRow): Menu => {
  const open = item("open-constellation", "Open constellation", {
    kind: "open-constellation",
    hostId: row.hostId,
    constellationId: row.constellation.id,
  });

  const { lead } = row;

  const states = lifecycle(row);

  if (lead === null) return [[open], states].filter((group) => group.length > 0);

  return [
    [
      open,
      ...(reviewable(lead)
        ? [
            item("open-review", "Open review", {
              kind: "open-review",
              hostId: row.hostId,
              sessionId: lead.id,
            }),
          ]
        : []),
    ],
    states,
    [copyId(lead)],
  ].filter((group) => group.length > 0);
};

/** A Host's row: a new agent session there while it's connected, Retry now while it isn't. */
export const hostMenu = (host: {
  readonly hostId: string;
  readonly name: string;
  readonly state: ConnectionState;
}): Menu =>
  host.state === "connected"
    ? [
        [
          item("new-session", `New agent session on ${host.name}…`, {
            kind: "new-session",
            hostId: host.hostId,
          }),
        ],
      ]
    : [[item("retry", "Retry now", { kind: "retry-host", hostId: host.hostId })]];

/** The Daemon command an action sends, or null for one that stays on the phone. */
export const commandOf = (action: MenuAction): Command | null =>
  Match.value(action).pipe(
    Match.when({ kind: "reply" }, replyCommand),
    Match.when({ kind: "send" }, ({ command }) => command),
    Match.orElse(() => null)
  );

export const replyCommand = (action: Extract<MenuAction, { readonly kind: "reply" }>): Command =>
  respondCommand(action.approval, action.reply);

/** The alert's title when a reply the menu sent is refused. */
export const failureTitle = (reply: Reply): string =>
  reply.kind === "deny" ? "Couldn't deny" : "Couldn't approve";

/** A finished Turn in the thread (MX-J): its receipt heads the menu, then Copy and Fork. */
export const turnMenu = (
  where: { readonly hostId: string; readonly sessionId: string },
  turn: { readonly turnId: string; readonly output: string }
): Menu => [
  [
    ...(turn.output === ""
      ? []
      : [{ ...item("copy", "Copy", { kind: "copy", text: turn.output }), symbol: "doc.on.doc" }]),
    {
      ...item("fork", "Fork from here", { kind: "fork", ...where, turnId: turn.turnId }),
      symbol: "arrow.triangle.branch",
      // ForkSession is "local" in DEVICE_COMMANDS: the Daemon refuses it from a phone.
      subtitle: "From the desktop app for now",
      disabled: true,
    },
  ],
];
