/**
 * The Host's computer use policy at run time (ADR 0104): each `polaris_desktop` call on an app
 * is decided by `decideAppUse`, asking the user through the Engine when it needs an approval.
 * A session's approvals are folded from its log; the Controlled apps live only in memory.
 */
import {
  type AppApprovalKind,
  type AppId,
  type AppPolicy,
  type AppRef,
  type ApprovalDecision,
  answerAppApproval,
  AppUseDecision,
  ControlledApp,
  controlApp,
  decideAppUse,
  DesktopApp,
  type DomainEvent,
  emptyAppPolicy,
  forgetSession,
  releaseSession,
  type SessionId,
} from "@polaris/protocol";
import { Clock, Context, Data, Effect, Layer, Predicate, Semaphore, Stream } from "effect";
import { shortHostName } from "../service/hostName.ts";
import { EventStore } from "../store/EventStore.ts";
import { ComputerUseHost } from "./host.ts";
import { builtInRefused } from "./refused.ts";

export interface AppUseCall {
  readonly sessionId: SessionId;
  readonly app: AppRef;
  /** Headed input: the real pointer and keyboard. */
  readonly headed: boolean;
  /** The tool call's abort: an abandoned call withdraws its approval. */
  readonly signal?: AbortSignal | undefined;
}

export type AppUseAnswer = Data.TaggedEnum<{
  /** `asked`: the user answered an approval for this call just now. */
  Allow: { readonly asked: boolean };
  /** `message` is the tool result the agent reads. */
  Refuse: { readonly message: string };
}>;

export const AppUseAnswer = Data.taggedEnum<AppUseAnswer>();

/** The Engine's `requestAppApproval`: the user's decision, or null when it closed unanswered. */
export type AskForApp = (
  sessionId: SessionId,
  input: {
    readonly kind: AppApprovalKind;
    readonly app: DesktopApp;
    readonly title: string;
    readonly detail: string | null;
  }
) => Effect.Effect<ApprovalDecision | null, unknown>;

export const appMessages = {
  refused: (app: string) =>
    `polaris_desktop doesn't drive ${app}: it would get around the approvals this session asks for. Only the user can allow it, in the computer use settings for this host. Until then, ask them to do this step.`,
  inUse: (app: string, title: string | null) =>
    `${app} is in use by ${title ?? "another session"}. Try again when that session's Turn ends.`,
  denied: (app: string) => `The user didn't allow ${app} for this session.`,
  headedDenied: (app: string) =>
    `The user didn't allow headed input in ${app}. Use the headless tools, or tell the user what you can't do without it.`,
  unanswered: (app: string) => `The approval for ${app} closed before the user answered.`,
  notReady: (host: string) => `Computer use isn't on for ${host} any more.`,
  noApprovals: "Polaris can't ask for approvals yet. Try again in a moment.",
};

const approvalCopy = (kind: AppApprovalKind, app: string) =>
  kind === "app"
    ? { title: `Use ${app}`, detail: `The agent wants to see and control ${app} on this Host.` }
    : {
        title: `Use the pointer and keyboard in ${app}`,
        detail: `${app} can't be controlled in the background, so the agent wants to move the real pointer and type with the real keyboard.`,
      };

export class AppControl extends Context.Service<
  AppControl,
  {
    /** Decides one call, asking the user when it must; when allowed, the session controls the app. */
    readonly use: (call: AppUseCall) => Effect.Effect<AppUseAnswer>;
    /** Whether the session controls an app now. */
    readonly controlling: (sessionId: SessionId) => Effect.Effect<boolean>;
    /** The session's Turn ended: its apps are released, its approvals stay. */
    readonly release: (sessionId: SessionId) => Effect.Effect<void>;
    /** The session stopped: released, and its approvals are read from the log again next time. */
    readonly forget: (sessionId: SessionId) => Effect.Effect<void>;
    /** Binds the Engine, which is built after this. Until then every approval is refused. */
    readonly bind: (ask: AskForApp) => Effect.Effect<void>;
  }
>()("polaris/daemon/computerUse/AppControl") {
  static readonly layer = Layer.effect(
    AppControl,
    Effect.suspend(() => make)
  );
}

const aborted = (signal: AbortSignal | undefined) =>
  signal === undefined
    ? Effect.never
    : Effect.callback<void>((resume) => {
        if (signal.aborted) return resume(Effect.void);
        const done = () => resume(Effect.void);
        signal.addEventListener("abort", done, { once: true });

        return Effect.sync(() => signal.removeEventListener("abort", done));
      });

type Asked = ReadonlyMap<string, { readonly appId: AppId; readonly kind: AppApprovalKind }>;

/** The app approvals a session's log asked for, by request id. */
const askedIn = (events: ReadonlyArray<DomainEvent>): Asked =>
  new Map(
    events.flatMap((event) => {
      if (!Predicate.isTagged(event, "ApprovalRequested")) return [];
      const { id, kind, app } = event.request;

      return (kind === "app" || kind === "headed-input") && app !== undefined
        ? [[id, { appId: app.id, kind }] as const]
        : [];
    })
  );

/**
 * A session's approvals as its log has them: each allow for the session, dropped when it was
 * archived. An "always allow" isn't a session's: the Host's list holds it.
 */
export const foldApprovals = (
  policy: AppPolicy,
  sessionId: SessionId,
  events: ReadonlyArray<DomainEvent>
): AppPolicy => {
  const asked = askedIn(events);

  return events.reduce((folded, event) => {
    if (Predicate.isTagged(event, "SessionStateChanged"))
      return event.state === "archived" ? forgetSession(folded, sessionId) : folded;

    const request = Predicate.isTagged(event, "ApprovalResolved")
      ? asked.get(event.requestId)
      : undefined;

    if (request === undefined || !Predicate.isTagged(event, "ApprovalResolved")) return folded;
    const always = Predicate.isTagged(event.decision, "Allow") && event.decision.remember;

    return always ? folded : answerAppApproval(folded, { sessionId, ...request }, event.decision);
  }, policy);
};

const make = Effect.gen(function* () {
  const host = yield* ComputerUseHost;
  const store = yield* EventStore;
  const hostName = shortHostName();
  let policy = emptyAppPolicy();
  let ask: AskForApp | null = null;
  const loaded = new Set<SessionId>();
  const since = new Map<AppId, ControlledApp>();
  const locks = new Map<SessionId, Semaphore.Semaphore>();

  const serially = (sessionId: SessionId) => {
    const lock = locks.get(sessionId) ?? Semaphore.makeUnsafe(1);
    locks.set(sessionId, lock);

    return lock.withPermits(1);
  };

  /** Tells the Host feed which apps are controlled, whenever that changed. */
  const publish = Effect.suspend(() => {
    for (const id of since.keys()) if (!policy.controllers.has(id)) since.delete(id);

    return host.setControlledApps([...since.values()]);
  });

  const releaseAll = Effect.suspend(() => {
    if (policy.controllers.size === 0) return Effect.void;
    policy = { ...policy, controllers: new Map() };

    return publish;
  });

  // Turning computer use off releases every Controlled app (`computerUse.disable`).
  yield* host.changes.pipe(
    Stream.filter((status) => !Predicate.isTagged(status.state, "Ready")),
    Stream.runForEach(() => releaseAll),
    Effect.forkScoped
  );

  /** The session's approvals so far, from its log: they survive a Daemon restart. */
  const load = Effect.fnUntraced(function* (sessionId: SessionId) {
    if (loaded.has(sessionId)) return;
    const upTo = (yield* store.model).sequence ?? 0;

    const events = yield* store
      .readEvents({
        after: 0,
        upTo,
        sessionId,
        eventTypes: ["ApprovalRequested", "ApprovalResolved", "SessionStateChanged"],
      })
      .pipe(Effect.orElseSucceed(() => []));

    policy = foldApprovals(
      policy,
      sessionId,
      events.map((envelope) => envelope.event)
    );
    loaded.add(sessionId);
  });

  /** The policy as of now: the Host's list is the always-allowed apps, and lifts a built-in refusal. */
  const current = (appId: AppId) =>
    Effect.map(host.allowedApps, (allowed): AppPolicy => {
      const always = new Set(allowed.map((entry) => entry.app.id));

      return {
        ...policy,
        always,
        refused: builtInRefused(appId) && !always.has(appId) ? new Set([appId]) : new Set(),
      };
    });

  const titleOf = (sessionId: SessionId) =>
    Effect.map(store.model, (model) => model.sessions.get(sessionId)?.session.title ?? null);

  const refuse = (message: string) => AppUseAnswer.Refuse({ message });

  /** Opens the approval and folds the answer in; the reason it wasn't allowed, or null. */
  const approve = Effect.fnUntraced(function* (call: AppUseCall, kind: AppApprovalKind) {
    if (ask === null) return appMessages.noApprovals;
    const app = new DesktopApp({ id: call.app.id, name: call.app.name, icon: null });

    const decision = yield* ask(call.sessionId, {
      kind,
      app,
      ...approvalCopy(kind, app.name),
    }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.raceFirst(Effect.as(aborted(call.signal), null))
    );

    if (decision === null) return appMessages.unanswered(app.name);

    if (!Predicate.isTagged(decision, "Allow"))
      return kind === "app" ? appMessages.denied(app.name) : appMessages.headedDenied(app.name);

    if (kind === "app" && decision.remember) yield* host.allowApp(app);
    else
      policy = answerAppApproval(
        policy,
        { sessionId: call.sessionId, appId: app.id, kind },
        decision
      );

    return null;
  });

  const take = Effect.fnUntraced(function* (call: AppUseCall, at: string) {
    policy = {
      ...policy,
      controllers: controlApp(yield* current(call.app.id), { ...call, appId: call.app.id })
        .controllers,
    };

    if (since.get(call.app.id)?.sessionId === call.sessionId) return;
    since.set(
      call.app.id,
      new ControlledApp({ app: call.app, sessionId: call.sessionId, since: at })
    );
    yield* publish;
  });

  const decide = Effect.fnUntraced(function* (call: AppUseCall) {
    if (!Predicate.isTagged((yield* host.current).state, "Ready"))
      return refuse(appMessages.notReady(hostName));
    yield* load(call.sessionId);
    const use = { sessionId: call.sessionId, appId: call.app.id, headed: call.headed };
    let asked = false;

    // At most the app approval, then the headed one, then the use itself.
    for (let round = 0; round < 3; round++) {
      const decision = decideAppUse(yield* current(use.appId), use);

      if (AppUseDecision.guards.Refused(decision))
        return refuse(appMessages.refused(call.app.name));

      if (AppUseDecision.guards.InUse(decision))
        return refuse(appMessages.inUse(call.app.name, yield* titleOf(decision.by)));

      if (AppUseDecision.guards.Allowed(decision)) {
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* take(call, at);

        return AppUseAnswer.Allow({ asked });
      }

      const refusal = yield* approve(call, decision.kind);

      if (refusal !== null) return refuse(refusal);
      asked = true;
    }

    return refuse(appMessages.unanswered(call.app.name));
  });

  return AppControl.of({
    use: (call) => serially(call.sessionId)(decide(call)),
    controlling: (sessionId) =>
      Effect.sync(() => [...policy.controllers.values()].includes(sessionId)),
    release: (sessionId) =>
      Effect.suspend(() => {
        policy = releaseSession(policy, sessionId);

        return publish;
      }),
    forget: (sessionId) =>
      Effect.suspend(() => {
        policy = forgetSession(policy, sessionId);
        loaded.delete(sessionId);
        locks.delete(sessionId);

        return publish;
      }),
    bind: (bound) => Effect.sync(() => void (ask = bound)),
  });
});
