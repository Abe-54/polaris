/**
 * The decider: validates a Client command against the current read model and
 * returns the events that record its intent. It is pure; everything it needs
 * from the outside world (ids, the clock, resolved attachments, a filesystem
 * probe) arrives in `DecideContext`. Side effects happen after commit, in the
 * reactors (`Engine.ts`).
 *
 * Everything that moves a Session State goes through the session lifecycle
 * machine (`session.ts`); this module builds its inputs and maps its output.
 */
import { basename, join } from "node:path";
import {
  type Actor,
  AgentSession,
  type Attachment,
  Command,
  type CommandId,
  CommandRejected,
  decideTurnAccess,
  type Grant,
  type NotGranted,
  DomainEvent,
  isKnownHarness,
  NotFound,
  type RiskSummary,
  type SessionId,
  SessionPlacement,
  type Turn,
  type TurnId,
  Workspace,
  type WorkspaceId,
  WorktreeId,
} from "@polaris/protocol";
import { Effect, Match, Predicate, Result } from "effect";
import {
  lastTurn,
  patchTurn,
  type ReadModel,
  type SessionRecord,
  workingTurn,
} from "../store/model.ts";
import { pickCelestial } from "../store/celestial.ts";
import { userTurn } from "./session.turns.ts";
import { reviewDeciders } from "./review.ts";
import { decideSession, type SessionInput } from "./session.ts";

export { stateChanged } from "./session.ts";

export interface DecideContext {
  readonly commandId: CommandId;
  readonly now: string;
  /** Label of the Client device that sent the command (for `ApprovalResolved.resolvedBy`). */
  readonly deviceLabel: string;
  /** Who sent it: stamped on the session starts, Turns and approvals it records. */
  readonly actor: Actor;
  readonly extensionGrant?: Grant | null;
  /** Fresh ids, used only by the commands that create something. */
  readonly newTurnId: TurnId;
  readonly newWorkspaceId: WorkspaceId;
  /** Attachments of StartSession / SendTurn / Steer, resolved from the AttachmentStore. */
  readonly attachments: ReadonlyArray<Attachment>;
  /** For RegisterWorkspace: what is at `path`. */
  readonly pathProbe: { readonly isDirectory: boolean; readonly isGitRepo: boolean } | null;
  /** For Steer: whether the session's Harness supports it. */
  readonly canSteer: boolean;
  /** For Steer: whether the session's Harness takes attachments in a steer. */
  readonly canSteerAttachments?: boolean;
  /** For SetModel: whether the session's Harness can change Model mid-session. */
  readonly canSwitchModel: boolean;
  /** For StopBackgroundTasks: whether the session's Harness can stop its background tasks. */
  readonly canStopBackground: boolean;
  /** For BackgroundCommand: whether the Harness can, and the ids of the commands running now. */
  readonly canBackgroundCommand: boolean;
  readonly runningCommands: ReadonlyArray<string>;
  /** For RunShellCommand: whether the session's Harness reads the user's shell commands. */
  readonly canRunShellCommand?: boolean;
  /** For CompactSession: whether a `/compact` Turn compacts the session's Harness. */
  readonly canCompact?: boolean;
  /**
   * The Turn the command names, looked up in memory or SQL (null if unknown):
   * ForkSession's `fromTurnId`, AcceptTurns' `throughTurnId`.
   */
  readonly namedTurn: Turn | null;
  /** For RecordVerdict: the Risk Summary it names (null if unknown). */
  readonly judgedSummary: RiskSummary | null;
}

export type Decision = Effect.Effect<
  ReadonlyArray<DomainEvent>,
  CommandRejected | NotFound | NotGranted
>;

/** Worktree ids are derived from the path, so every observer of a path agrees on its id. */
export const worktreeIdFor = (path: string): WorktreeId =>
  WorktreeId.make(`wt_${Bun.hash(path).toString(16)}`);

/**
 * The branch of a Fork's own Worktree: `polaris/fork-<8 hex>`, derived from the
 * Fork's session id so the decider and the reactor agree on it.
 */
export const forkBranch = (sessionId: SessionId): string =>
  `polaris/fork-${Bun.hash(sessionId).toString(16).padStart(16, "0").slice(0, 8)}`;

export const titleFromPrompt = (prompt: string): string => {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";

  if (line === "") return "New session";

  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

/** What the engine sends the Harness when the user continues an Interrupted Turn. */
export const CONTINUE_PROMPT = "Continue from where you left off.";

type CommandOf<Tag extends Command["_tag"]> = Extract<Command, { _tag: Tag }>;

/** What each command's decision can use: the model, the context, and the verdicts. */
export interface Deciding {
  readonly model: ReadModel;
  readonly ctx: DecideContext;
  readonly reject: (reason: string) => Decision;
  readonly notFound: (what: string, id: string) => Decision;
  readonly ok: (...events: ReadonlyArray<DomainEvent>) => Decision;
  readonly withSession: (sessionId: SessionId, f: (record: SessionRecord) => Decision) => Decision;
  /** Run the session machine: its events, or its reason to refuse. */
  readonly lifecycle: (record: SessionRecord | undefined, input: SessionInput) => Decision;
  readonly newTurn: (
    session: AgentSession,
    prompt: string,
    attachments?: ReadonlyArray<Attachment>
  ) => Turn;
}

/** The machine decides; the decider says who asked (history: "approved by Raycast"). */
const withActor = (actor: Actor, event: DomainEvent): DomainEvent =>
  Match.value(event).pipe(
    Match.tags({
      SessionCreated: (e) => DomainEvent.cases.SessionCreated.make({ ...e, actor }),
      TurnStarted: (e) => DomainEvent.cases.TurnStarted.make({ ...e, actor }),
      ApprovalResolved: (e) => DomainEvent.cases.ApprovalResolved.make({ ...e, actor }),
    }),
    Match.orElse((e) => e)
  );

const deciding = (model: ReadModel, ctx: DecideContext): Deciding => {
  const reject = (reason: string) =>
    Effect.fail(new CommandRejected({ commandId: ctx.commandId, reason }));

  const notFound = (what: string, id: string) => Effect.fail(new NotFound({ what, id }));
  const ok = (...events: ReadonlyArray<DomainEvent>): Decision => Effect.succeed(events);

  return {
    model,
    ctx,
    reject,
    notFound,
    ok,
    withSession: (sessionId, f) => {
      const record = model.sessions.get(sessionId);

      return record === undefined ? notFound("session", sessionId) : f(record);
    },
    lifecycle: (record, input) => {
      const decision = decideSession(record, input);

      return decision.rejection !== null
        ? reject(decision.rejection)
        : ok(...decision.events.map((event) => withActor(ctx.actor, event)));
    },
    newTurn: (session, prompt, attachments = ctx.attachments) =>
      userTurn(session, { id: ctx.newTurnId, prompt, attachments, at: ctx.now }),
  };
};

const registerWorkspace = (d: Deciding, command: CommandOf<"RegisterWorkspace">): Decision => {
  const probe = d.ctx.pathProbe;

  if (probe === null || !probe.isDirectory) return d.reject(`${command.path} is not a directory`);

  for (const workspace of d.model.workspaces.values()) {
    if (workspace.path === command.path) return d.reject(`${command.path} is already registered`);
  }

  const workspace = new Workspace({
    id: d.ctx.newWorkspaceId,
    path: command.path,
    name: command.name ?? basename(command.path),
    isGitRepo: probe.isGitRepo,
    worktreeRoot: `${command.path}.worktrees`,
    hidden: false,
    registeredAt: d.ctx.now,
  });

  return d.ok(DomainEvent.cases.WorkspaceRegistered.make({ workspace }));
};

const setWorkspaceHidden = (d: Deciding, command: CommandOf<"SetWorkspaceHidden">): Decision => {
  const workspace = d.model.workspaces.get(command.workspaceId);

  if (workspace === undefined) return d.notFound("workspace", command.workspaceId);

  if (workspace.hidden === command.hidden) return d.ok();

  const updated = new Workspace({
    id: workspace.id,
    path: workspace.path,
    name: workspace.name,
    isGitRepo: workspace.isGitRepo,
    worktreeRoot: workspace.worktreeRoot,
    hidden: command.hidden,
    worktreeSetup: workspace.worktreeSetup,
    registeredAt: workspace.registeredAt,
  });

  return d.ok(DomainEvent.cases.WorkspaceUpdated.make({ workspace: updated }));
};

const removeWorkspace = (d: Deciding, command: CommandOf<"RemoveWorkspace">): Decision => {
  if (!d.model.workspaces.has(command.workspaceId)) {
    return d.notFound("workspace", command.workspaceId);
  }

  for (const record of d.model.sessions.values()) {
    if (record.session.workspaceId === command.workspaceId && record.session.state !== "archived") {
      return d.reject("archive the Workspace's Agent Sessions before removing it");
    }
  }

  return d.ok(DomainEvent.cases.WorkspaceRemoved.make({ workspaceId: command.workspaceId }));
};

const isUsableBranch = (branch: string) =>
  branch !== "" &&
  !branch.startsWith("/") &&
  !branch.startsWith("-") &&
  !branch.split("/").some((part) => part === ".." || part === ".");

/** Where a new session works: its cwd and Worktree, or the refusal of its placement. */
type Placed = Result.Result<
  { readonly cwd: string; readonly worktreeId: WorktreeId | null },
  Decision
>;

const place = (d: Deciding, workspace: Workspace, placement: SessionPlacement): Placed =>
  SessionPlacement.match<Placed>(placement, {
    InPlace: () => Result.succeed({ cwd: workspace.path, worktreeId: null }),
    NewWorktree: ({ branch: requested }) => {
      if (!workspace.isGitRepo)
        return Result.fail(d.reject("a new Worktree needs a git repository"));
      const branch = requested.trim();

      if (!isUsableBranch(branch)) {
        return Result.fail(d.reject(`"${requested}" is not a usable branch name`));
      }

      const cwd = join(workspace.worktreeRoot, branch);
      const worktreeId = worktreeIdFor(cwd);

      if (d.model.worktrees.has(worktreeId)) {
        return Result.fail(d.reject(`a Worktree already exists at ${cwd}`));
      }

      return Result.succeed({ cwd, worktreeId });
    },
    ExistingWorktree: ({ path }) => {
      const worktree = [...d.model.worktrees.values()].find(
        (w) => w.workspaceId === workspace.id && w.path === path
      );

      if (worktree === undefined) return Result.fail(d.notFound("worktree", path));

      return Result.succeed({ cwd: worktree.path, worktreeId: worktree.id });
    },
    ReviewCheckout: ({ checkoutId }) => {
      const checkout = d.model.reviewCheckouts.get(checkoutId);

      if (checkout === undefined || checkout.workspaceId !== workspace.id) {
        return Result.fail(d.notFound("review checkout", checkoutId));
      }

      if (checkout.head === null) {
        return Result.fail(d.reject("the Review Checkout isn't checked out yet"));
      }

      return Result.succeed({ cwd: checkout.path, worktreeId: null });
    },
  });

const startSession = (d: Deciding, command: CommandOf<"StartSession">): Decision => {
  if (d.model.sessions.has(command.sessionId)) {
    return d.reject(`session ${command.sessionId} already exists`);
  }

  if (!isKnownHarness(command.harness)) return d.reject(unknownHarness(command.harness));
  const workspace = d.model.workspaces.get(command.workspaceId);

  if (workspace === undefined) return d.notFound("workspace", command.workspaceId);
  const placed = place(d, workspace, command.placement);

  if (Result.isFailure(placed)) return placed.failure;

  const session = new AgentSession({
    id: command.sessionId,
    workspaceId: workspace.id,
    harness: command.harness,
    title: titleFromPrompt(command.prompt),
    cwd: placed.success.cwd,
    worktreeId: placed.success.worktreeId,
    state: "starting",
    permissionMode: command.permissionMode,
    model: command.model,
    effort: command.effort,
    serviceTier: command.harness === "codex" ? (command.serviceTier ?? null) : null,
    celestial: pickCelestial(d.model.sessions.values(), {
      id: command.sessionId,
      workspaceId: workspace.id,
    }),
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 0,
    contextUsage: null,
    lastError: null,
    origin: command.origin ?? null,
    createdAt: d.ctx.now,
    updatedAt: d.ctx.now,
  });

  return d.lifecycle(undefined, {
    type: "session.start",
    session,
    turn: d.newTurn(session, command.prompt),
  });
};

const forkSession = (d: Deciding, command: CommandOf<"ForkSession">): Decision => {
  if (d.model.sessions.has(command.sessionId)) {
    return d.reject(`session ${command.sessionId} already exists`);
  }

  if (!isKnownHarness(command.harness)) return d.reject(unknownHarness(command.harness));

  return d.withSession(command.fromSessionId, (parent) => {
    const turn =
      parent.turns.find((t) => t.id === command.fromTurnId) ??
      (d.ctx.namedTurn?.id === command.fromTurnId ? d.ctx.namedTurn : undefined);

    if (turn === undefined) return d.notFound("turn", command.fromTurnId);

    if (turn.status === "working") return d.reject("the Turn is still in flight");
    // Its own Worktree at the Turn's after-checkpoint, or the parent's directory.
    // See docs/adr/0005-a-fork-gets-its-own-worktree.md.
    const workspace = d.model.workspaces.get(parent.session.workspaceId);
    let cwd = parent.session.cwd;
    let worktreeId = parent.session.worktreeId;

    if (workspace?.isGitRepo === true && turn.checkpointAfter !== null) {
      cwd = join(workspace.worktreeRoot, forkBranch(command.sessionId));
      worktreeId = worktreeIdFor(cwd);

      if (d.model.worktrees.has(worktreeId)) return d.reject(`a Worktree already exists at ${cwd}`);
    }

    const inherits = parent.session.harness === command.harness;

    const session = new AgentSession({
      id: command.sessionId,
      workspaceId: parent.session.workspaceId,
      harness: command.harness,
      title: `Fork of ${parent.session.title}`,
      cwd,
      worktreeId,
      state: "dormant",
      permissionMode: parent.session.permissionMode,
      // The Model the Fork asks for, else the parent's for the same Harness.
      model: command.model ?? (inherits ? parent.session.model : null),
      effort: command.effort ?? (command.model === null && inherits ? parent.session.effort : null),
      serviceTier:
        command.harness === "codex"
          ? (command.serviceTier ?? (inherits ? parent.session.serviceTier : null))
          : null,
      celestial: pickCelestial(d.model.sessions.values(), {
        id: command.sessionId,
        workspaceId: parent.session.workspaceId,
      }),
      parentSessionId: parent.session.id,
      forkedFromTurnId: turn.id,
      harnessCursor: null,
      turnCount: 0,
      contextUsage: null,
      lastError: null,
      createdAt: d.ctx.now,
      updatedAt: d.ctx.now,
    });

    return d.lifecycle(undefined, { type: "session.fork", session });
  });
};

const unknownHarness = (kind: string) => `${kind} is not a Harness this Daemon drives`;

const setModel = (d: Deciding, command: CommandOf<"SetModel">): Decision =>
  d.withSession(command.sessionId, (record) => {
    if (command.serviceTier != null && record.session.harness !== "codex")
      return d.reject("Fast mode is only available for Codex");

    if (command.model !== null && command.model.trim() === "")
      return d.reject("a Model cannot be empty");

    return d.lifecycle(record, {
      type: "model.set",
      model: command.model,
      effort: command.effort,
      serviceTier: command.serviceTier ?? record.session.serviceTier,
      canSwitchModel: d.ctx.canSwitchModel,
    });
  });

const renameSession = (d: Deciding, command: CommandOf<"RenameSession">): Decision =>
  d.withSession(command.sessionId, () => {
    const title = command.title.trim();

    if (title === "") return d.reject("a title cannot be empty");

    return d.ok(DomainEvent.cases.SessionRenamed.make({ sessionId: command.sessionId, title }));
  });

/** Pins at the current time, or unpins; asking for what's already so commits nothing. */
const pinSession = (d: Deciding, command: CommandOf<"PinSession">): Decision =>
  d.withSession(command.sessionId, (record) => {
    if (command.pinned === (record.session.pinnedAt != null)) return d.ok();

    return d.ok(
      DomainEvent.cases.SessionPinned.make({
        sessionId: command.sessionId,
        pinnedAt: command.pinned ? d.ctx.now : null,
      })
    );
  });

/** A session preference, not lifecycle: the reset itself goes through the machine as a Continue. */
const setResumeAtReset = (d: Deciding, command: CommandOf<"SetResumeAtReset">): Decision =>
  d.withSession(command.sessionId, (record) => {
    if (record.session.state === "archived") return d.reject("the session is Archived");

    if (command.resumeAtReset === record.session.resumeAtReset) return d.ok();

    return d.ok(
      DomainEvent.cases.SessionResumeAtResetChanged.make({
        sessionId: command.sessionId,
        resumeAtReset: command.resumeAtReset,
      })
    );
  });

/** A new Turn with the last Turn's prompt and attachments (or its shell command); the machine checks that it Failed. */
const retry = (d: Deciding, command: CommandOf<"Retry">): Decision =>
  d.withSession(command.sessionId, (record) => {
    const last = lastTurn(record);

    if (last === undefined) return d.reject("there is no Failed Turn to retry");

    const turn = patchTurn(d.newTurn(record.session, last.prompt, last.attachments), {
      shellCommand: last.shellCommand,
    });

    return d.lifecycle(record, { type: "turn.retry", turn });
  });

/**
 * The user's shell command, as a new Turn whose prompt reads `! <command>`: accepted where
 * `SendTurn` starts a Turn, never into a Turn in flight (not even the Harness's own).
 */
const runShellCommand = (d: Deciding, command: CommandOf<"RunShellCommand">): Decision =>
  d.withSession(command.sessionId, (record) => {
    const shell = command.command.trim();

    if (d.ctx.canRunShellCommand !== true)
      return d.reject(`${record.session.harness} can't run shell commands`);

    if (shell === "") return d.reject("the command is empty");

    if (workingTurn(record) !== undefined)
      return d.reject("the session is working; wait for the Turn to end");

    const turn = patchTurn(d.newTurn(record.session, `! ${shell}`, []), { shellCommand: shell });

    return d.lifecycle(record, { type: "turn.send", turn });
  });

/** What a Turn sends the Harness to compact its context window (Claude Code's and Codex's command). */
export const COMPACT_PROMPT = "/compact";

/**
 * Idle compaction's Turn: `/compact`, marked `idleCompaction`. Only an Idle or Dormant session
 * with nothing in flight or pending; anything else means the user came back first.
 */
const compactSession = (d: Deciding, command: CommandOf<"CompactSession">): Decision =>
  d.withSession(command.sessionId, (record) => {
    const { state } = record.session;

    if (d.ctx.canCompact !== true) return d.reject(`${record.session.harness} can't compact`);

    if (state !== "idle" && state !== "dormant") return d.reject(`the session is ${state}`);

    if (workingTurn(record) !== undefined || record.pending.size > 0)
      return d.reject("the session is working; wait for the Turn to end");

    const turn = patchTurn(d.newTurn(record.session, COMPACT_PROMPT, []), {
      idleCompaction: true,
    });

    return d.lifecycle(record, { type: "turn.send", turn });
  });

/** A lifecycle command of an existing session: the machine input it stands for. */
const onSession = (d: Deciding, sessionId: SessionId, input: SessionInput): Decision =>
  d.withSession(sessionId, (record) => d.lifecycle(record, input));

export const decide = (model: ReadModel, command: Command, ctx: DecideContext): Decision => {
  const mode =
    "sessionId" in command
      ? (model.sessions.get(command.sessionId)?.session.permissionMode ?? null)
      : null;

  const refusal = decideTurnAccess(ctx.extensionGrant ?? null, command, mode);

  if (refusal !== null) return Effect.fail(refusal);
  const d = deciding(model, ctx);

  return Command.match<Decision>(command, {
    RegisterWorkspace: (c) => registerWorkspace(d, c),
    SetWorktreeSetup: (c) => {
      const workspace = d.model.workspaces.get(c.workspaceId);

      if (workspace === undefined) return d.notFound("workspace", c.workspaceId);

      return d.ok(
        DomainEvent.cases.WorkspaceUpdated.make({
          workspace: new Workspace({
            id: workspace.id,
            path: workspace.path,
            name: workspace.name,
            isGitRepo: workspace.isGitRepo,
            worktreeRoot: workspace.worktreeRoot,
            hidden: workspace.hidden,
            registeredAt: workspace.registeredAt,
            worktreeSetup: c.setup,
          }),
        })
      );
    },
    SetWorkspaceHidden: (c) => setWorkspaceHidden(d, c),
    RemoveWorkspace: (c) => removeWorkspace(d, c),
    StartSession: (c) => startSession(d, c),
    SendTurn: (c) =>
      d.withSession(c.sessionId, (record) =>
        d.lifecycle(record, { type: "turn.send", turn: d.newTurn(record.session, c.prompt) })
      ),
    RunShellCommand: (c) => runShellCommand(d, c),
    CompactSession: (c) => compactSession(d, c),
    Continue: (c) => onSession(d, c.sessionId, { type: "turn.continue" }),
    Retry: (c) => retry(d, c),
    Steer: (c) =>
      onSession(d, c.sessionId, {
        type: "turn.steer",
        canSteer: ctx.canSteer,
        takesAttachments: (c.attachments ?? []).length === 0 || ctx.canSteerAttachments === true,
      }),
    Interrupt: (c) => onSession(d, c.sessionId, { type: "turn.interrupt" }),
    StopBackgroundTasks: (c) =>
      onSession(d, c.sessionId, {
        type: "background.stop",
        taskIds: c.taskIds,
        canStop: ctx.canStopBackground,
      }),
    BackgroundCommand: (c) =>
      onSession(d, c.sessionId, {
        type: "command.background",
        itemId: c.itemId,
        canBackground: ctx.canBackgroundCommand,
        running: ctx.runningCommands,
      }),
    RespondToApproval: (c) =>
      Predicate.isTagged(c.decision, "Provided")
        ? d.reject("send a secret with secret.provide")
        : onSession(d, c.sessionId, {
            type: "approval.respond",
            requestId: c.requestId,
            decision: c.decision,
            resolvedBy: ctx.deviceLabel,
          }),
    RenameSession: (c) => renameSession(d, c),
    PinSession: (c) => pinSession(d, c),
    SetResumeAtReset: (c) => setResumeAtReset(d, c),
    SetPermissionMode: (c) =>
      onSession(d, c.sessionId, { type: "permissionMode.set", permissionMode: c.permissionMode }),
    SetModel: (c) => setModel(d, c),
    ForkSession: (c) => forkSession(d, c),
    ArchiveSession: (c) => onSession(d, c.sessionId, { type: "session.archive", at: ctx.now }),
    UnarchiveSession: (c) => onSession(d, c.sessionId, { type: "session.unarchive" }),
    OpenInTerminal: (c) => onSession(d, c.sessionId, { type: "terminal.open" }),
    ReturnFromTerminal: (c) => onSession(d, c.sessionId, { type: "terminal.return" }),
    ...reviewDeciders(d),
  });
};
