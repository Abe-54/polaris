/**
 * The computer use policy Polaris enforces whatever the Harness and permission mode (ADR 0107):
 * which app an Agent Session may act in, as pure functions the Daemon folds its state through.
 * Specified by `packages/spec/computer-use.qnt`; `computer-use.md` has the rules in prose.
 */
import { Match, Schema } from "effect";
import type { AppId } from "./computerUse.ts";
import { ApprovalDecision, type ApprovalKind } from "./domain.ts";
import { Actor } from "./extensions.ts";
import { SessionId } from "./ids.ts";

/** The two ApprovalKinds computer use opens. */
export const AppApprovalKind = Schema.Literals(["app", "headed-input"]);

export type AppApprovalKind = typeof AppApprovalKind.Type;

/**
 * What a session's use of an app comes to, the first that applies. `Refused`: the app is on the
 * built-in always-refused list. `InUse`: another session controls it. `NeedsApproval`: open
 * an approval of that kind and wait. `Allowed`: act, and the session controls the app.
 */
export const AppUseDecision = Schema.TaggedUnion({
  Refused: {},
  InUse: { by: SessionId },
  NeedsApproval: { kind: AppApprovalKind },
  Allowed: {},
});

export type AppUseDecision = typeof AppUseDecision.Type;

export interface AppUse {
  readonly sessionId: SessionId;
  readonly appId: AppId;
  /** Headed input: the real pointer and keyboard. */
  readonly headed: boolean;
}

/** A Host's computer use state: nothing in it depends on a permission mode or a Harness. */
export interface AppPolicy {
  /** The built-in list; no approval and no always-allow reaches these. */
  readonly refused: ReadonlySet<AppId>;
  /** The Host's always-allowed apps. */
  readonly always: ReadonlySet<AppId>;
  /** Apps each session's user allowed for that session. */
  readonly allowed: ReadonlyMap<SessionId, ReadonlySet<AppId>>;
  /** Apps each session's user allowed headed input in, for that session. */
  readonly headed: ReadonlyMap<SessionId, ReadonlySet<AppId>>;
  /** The session controlling each app now. */
  readonly controllers: ReadonlyMap<AppId, SessionId>;
}

export const emptyAppPolicy = (
  refused: Iterable<AppId> = [],
  always: Iterable<AppId> = []
): AppPolicy => ({
  refused: new Set(refused),
  always: new Set(always),
  allowed: new Map(),
  headed: new Map(),
  controllers: new Map(),
});

const holds = (grants: ReadonlyMap<SessionId, ReadonlySet<AppId>>, use: AppUse) =>
  grants.get(use.sessionId)?.has(use.appId) === true;

const granting = (
  grants: ReadonlyMap<SessionId, ReadonlySet<AppId>>,
  sessionId: SessionId,
  appId: AppId
) => new Map(grants).set(sessionId, new Set(grants.get(sessionId)).add(appId));

const needs = (policy: AppPolicy, use: AppUse): AppApprovalKind | null => {
  if (!policy.always.has(use.appId) && !holds(policy.allowed, use)) return "app";

  return use.headed && !holds(policy.headed, use) ? "headed-input" : null;
};

export const decideAppUse = (policy: AppPolicy, use: AppUse): AppUseDecision => {
  if (policy.refused.has(use.appId)) return AppUseDecision.cases.Refused.make({});
  const by = policy.controllers.get(use.appId);

  if (by !== undefined && by !== use.sessionId) return AppUseDecision.cases.InUse.make({ by });
  const kind = needs(policy, use);

  return kind === null
    ? AppUseDecision.cases.Allowed.make({})
    : AppUseDecision.cases.NeedsApproval.make({ kind });
};

/** The session takes control of the app when its use is `Allowed`; otherwise nothing changes. */
export const controlApp = (policy: AppPolicy, use: AppUse): AppPolicy =>
  AppUseDecision.guards.Allowed(decideAppUse(policy, use))
    ? { ...policy, controllers: new Map(policy.controllers).set(use.appId, use.sessionId) }
    : policy;

const rememberRefusal = (kind: AppApprovalKind, actor: Actor | null) => {
  if (kind === "headed-input") return "Headed input can only be allowed for this session";

  return actor !== null && Actor.guards.Extension(actor)
    ? "An extension can only allow an app for this session"
    : null;
};

/**
 * Why `decision` can't answer an approval of `kind`, as the user reads it; null when it can.
 * A headed-input approval is never always-allowed, an Extension never always-allows an app
 * (`actor` is who sent the command), and neither kind takes an answer or a secret.
 */
export const appDecisionRefusal = (
  kind: ApprovalKind,
  decision: ApprovalDecision,
  actor: Actor | null = null
): string | null => {
  if (kind !== "app" && kind !== "headed-input") return null;

  return Match.value(decision).pipe(
    Match.tag("Deny", () => null),
    Match.tag("Allow", ({ remember }) => (remember ? rememberRefusal(kind, actor) : null)),
    Match.orElse(() => "Allow or deny this app")
  );
};

/**
 * The user's answer to a session's approval. `Allow` grants that session the app (or headed
 * input in it); with `remember`, an `app` approval always-allows it on the Host instead.
 * `Deny` and a decision `appDecisionRefusal` refuses change nothing: the next use asks again.
 * The Daemon rejects a decision refused for its `actor` before it is ever resolved.
 */
export const answerAppApproval = (
  policy: AppPolicy,
  request: { readonly sessionId: SessionId; readonly appId: AppId; readonly kind: AppApprovalKind },
  decision: ApprovalDecision
): AppPolicy => {
  const { sessionId, appId, kind } = request;

  if (!ApprovalDecision.guards.Allow(decision) || appDecisionRefusal(kind, decision) !== null)
    return policy;

  if (kind === "headed-input")
    return { ...policy, headed: granting(policy.headed, sessionId, appId) };

  return decision.remember
    ? { ...policy, always: new Set(policy.always).add(appId) }
    : { ...policy, allowed: granting(policy.allowed, sessionId, appId) };
};

const without = <K, V>(map: ReadonlyMap<K, V>, drop: (key: K, value: V) => boolean) =>
  new Map([...map].filter(([key, value]) => !drop(key, value)));

/** The session's Turn ended (or the Daemon restarted): every app it controls is released. */
export const releaseSession = (policy: AppPolicy, sessionId: SessionId): AppPolicy => ({
  ...policy,
  controllers: without(policy.controllers, (_, by) => by === sessionId),
});

/** The session is archived or removed: its approvals go with it. */
export const forgetSession = (policy: AppPolicy, sessionId: SessionId): AppPolicy => ({
  ...releaseSession(policy, sessionId),
  allowed: without(policy.allowed, (id) => id === sessionId),
  headed: without(policy.headed, (id) => id === sessionId),
});

/** `computerUse.removeAllowedApp`: sessions that relied on it ask again. */
export const withoutAllowedApp = (policy: AppPolicy, appId: AppId): AppPolicy => ({
  ...policy,
  always: new Set([...policy.always].filter((id) => id !== appId)),
});
