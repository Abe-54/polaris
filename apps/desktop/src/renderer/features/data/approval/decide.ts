/**
 * How every place answers a Data Source Approval the same way: the scope its card shows, the
 * decision Approve sends from any path, and what this device already decided, so each view agrees.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  DataSource,
  OriginScope,
  SessionId,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Decisions } from "../../../commands.ts";
import { approveOrigin, neededScope, originTarget } from "../../requests/approval/model.ts";
import {
  approveDecision,
  type DataScope,
  type DataSourceTarget,
  dataSourceTarget,
} from "./model.ts";

interface Grant {
  readonly hostKey: string;
  readonly target: DataSourceTarget;
  readonly scope: DataScope;
}

interface State {
  /** The scope each request's card shows; "target" until the user picks. */
  readonly scopes: Readonly<Record<string, DataScope>>;
  /** The scope each Origin Approval's card shows; what its Send needs until the user picks. */
  readonly originScopes: Readonly<Record<string, OriginScope>>;
  /** Requests this device answered, until the Daemon resolves them. */
  readonly decided: Readonly<Record<string, "approved" | "denied">>;
  /** Targets approved here, for other sessions still asking for them. */
  readonly grants: ReadonlyArray<Grant>;
}

export const decisionStore = createStore<State>(() => ({
  scopes: {},
  originScopes: {},
  decided: {},
  grants: [],
}));

export const approvalScope = (requestId: string): DataScope =>
  decisionStore.getState().scopes[requestId] ?? "target";

export const useApprovalScope = (requestId: string): DataScope =>
  useStore(decisionStore, (s) => s.scopes[requestId] ?? "target");

export const setApprovalScope = (requestId: string, scope: DataScope) =>
  decisionStore.setState((s) => ({ ...s, scopes: { ...s.scopes, [requestId]: scope } }));

export const useDecidedHere = (requestId: string) =>
  useStore(decisionStore, (s) => s.decided[requestId] ?? null);

/** An Origin Approval's scope: the user's pick, else what the waiting Send needs. */
export const originApprovalScope = (request: ApprovalRequest): OriginScope => {
  const target = originTarget(request);

  return (
    decisionStore.getState().originScopes[request.id] ??
    (target === null ? "reads" : neededScope(target))
  );
};

export const useOriginApprovalScope = (requestId: string, needed: OriginScope): OriginScope =>
  useStore(decisionStore, (s) => s.originScopes[requestId] ?? needed);

export const setOriginApprovalScope = (requestId: string, scope: OriginScope) =>
  decisionStore.setState((s) => ({
    ...s,
    originScopes: { ...s.originScopes, [requestId]: scope },
  }));

/** A request whose card remembers its decision and shows it in every view. */
const hasCard = (request: ApprovalRequest) =>
  dataSourceTarget(request) !== null || originTarget(request) !== null;

/**
 * Approve from any path: a Data Source Approval's is the card's, remembered; writes and profiles run once;
 * others as asked.
 */
export const allowFor = (request: ApprovalRequest, remember: boolean): ApprovalDecision => {
  if (request.dataWrite !== undefined || request.profileAttach !== undefined)
    return Decisions.Allow({ remember: false });

  if (originTarget(request) !== null) return approveOrigin(originApprovalScope(request));

  return dataSourceTarget(request) === null
    ? Decisions.Allow({ remember })
    : approveDecision(approvalScope(request.id));
};

/** No path offers "Always allow" for a Data Source or Origin Approval (its card chooses), write or profile. */
export const offersAlwaysAllow = (request: ApprovalRequest) =>
  !hasCard(request) && request.dataWrite === undefined && request.profileAttach === undefined;

/** The same server, database and user, as the Daemon keys an approval. */
export const sameTarget = (
  a: DataSourceTarget,
  b: Omit<DataSourceTarget, "sourceId" | "sourceName">
) =>
  a.engine === b.engine &&
  a.host === b.host &&
  a.port === b.port &&
  a.database === b.database &&
  (a.user ?? "") === (b.user ?? "");

/** Whether approving `granted` at `scope` lets agents read `asked`; a server grant is per user. */
export const covers = (granted: DataSourceTarget, scope: DataScope, asked: DataSourceTarget) =>
  scope === "server"
    ? granted.engine === asked.engine &&
      granted.host === asked.host &&
      granted.port === asked.port &&
      (granted.user ?? "") === (asked.user ?? "")
    : sameTarget(granted, asked);

/** The listed Data Source that points at the request's target, whatever it's called now. */
export const sourceForTarget = (
  sources: ReadonlyArray<DataSource>,
  target: DataSourceTarget
): DataSource | undefined => sources.find((s) => sameTarget(target, s));

/** Records a decision being sent, so every view of the request shows it at once. */
export const noteDecision = (request: ApprovalRequest, decision: ApprovalDecision) => {
  if (!hasCard(request)) return;
  const approved = Predicate.isTagged(decision, "Allow");

  decisionStore.setState((s) => ({
    ...s,
    decided: { ...s.decided, [request.id]: approved ? "approved" : "denied" },
  }));
};

/** After the Host accepted an Approve: other requests it covers are answered too. */
export const noteGrant = (
  hostKey: string,
  request: ApprovalRequest,
  decision: ApprovalDecision
) => {
  const target = dataSourceTarget(request);

  if (target === null || !Predicate.isTagged(decision, "Allow")) return;
  const grant = { hostKey, target, scope: decision.dataScope ?? "target" };

  decisionStore.setState((s) => ({ ...s, grants: [...s.grants, grant] }));
};

const settled = new Set<string>();

/** True the first time only: an answer sent for the user is never sent again if refused. */
export const settleOnce = (requestId: string) => {
  if (settled.has(requestId)) return false;
  settled.add(requestId);

  return true;
};

/** A refused answer: the request is open again in every view. */
export const forgetDecision = (requestId: string) =>
  decisionStore.setState((s) => {
    const { [requestId]: _gone, ...decided } = s.decided;

    return { ...s, decided };
  });

export interface PendingOn {
  readonly sessionId: SessionId;
  readonly request: ApprovalRequest;
}

/** Requests on the Host still asking for a target this device approved: they're answered too. */
export const coveredPending = (
  hostKey: string,
  pending: ReadonlyArray<PendingOn>,
  state: Pick<State, "decided" | "grants">
): ReadonlyArray<PendingOn> =>
  pending.filter(({ request }) => {
    const target = dataSourceTarget(request);

    return (
      target !== null &&
      state.decided[request.id] === undefined &&
      state.grants.some((g) => g.hostKey === hostKey && covers(g.target, g.scope, target))
    );
  });
