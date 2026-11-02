/**
 * Action Spans (ADR 0095): a root Span per user action, a command run or a tracked click. The IPC
 * requests the action causes carry its trace, so main's and the Daemon's Spans nest under it.
 */
import type { PolarisApi, RequestOptions } from "../../../shared/api.ts";
import { type RendererSelfTraces, type RendererSpan, selfTraces } from "./spans.ts";

/** Quiet time after the last request settles: React commits a click, and runs the effects that
 * load what it opened, within a frame or two. */
export const ACTION_QUIET_MS = 50;

/** The longest an action Span stays open, so a slow load or a stuck request can't hold it. */
export const ACTION_BOUND_MS = 3_000;

/** How the user started it; kept short and free of user content. */
export type ActionVia = "command" | "click";

interface OpenAction {
  readonly span: RendererSpan;
  readonly now: () => number;
  pending: number;
  lastAt: number;
  /** False once a newer action started: requests from then on are the newer one's. */
  adopting: boolean;
  failure: string | undefined;
  cancelQuiet: (() => void) | null;
  cancelBound: () => void;
  done: boolean;
}

/** A request joining an action: send its `trace`, then `settle` when it answers. */
export interface ActionChild {
  readonly trace: NonNullable<RequestOptions["trace"]>;
  readonly settle: () => void;
}

export interface ActionTracesOptions {
  readonly traces: () => RendererSelfTraces | null;
  /** Arms a timer; the result cancels it. */
  readonly setTimeout?: (run: () => void, ms: number) => () => void;
}

const failureOf = (cause: unknown) => (cause instanceof Error ? cause.name : "failed");

export const createActionTraces = ({
  traces,
  setTimeout: arm = (run, ms) => {
    const handle = globalThis.setTimeout(run, ms);

    return () => globalThis.clearTimeout(handle);
  },
}: ActionTracesOptions) => {
  let open: OpenAction | null = null;
  let handling = false;

  const finish = (action: OpenAction, atMs?: number) => {
    if (action.done) return;
    action.done = true;
    action.cancelQuiet?.();
    action.cancelBound();

    if (open === action) open = null;
    action.span.end(action.failure, undefined, atMs);
  };

  const quietThenFinish = (action: OpenAction) => {
    action.cancelQuiet?.();
    action.cancelQuiet = arm(() => {
      action.cancelQuiet = null;

      if (action.pending === 0) finish(action, action.lastAt);
    }, ACTION_QUIET_MS);
  };

  const idle = (action: OpenAction) => {
    if (action.done || action.pending > 0) return;

    if (action.adopting) quietThenFinish(action);
    else finish(action, action.lastAt);
  };

  const release = (action: OpenAction) => {
    action.pending -= 1;
    action.lastAt = action.now();
    idle(action);
  };

  const begin = (id: string, label: string, via: ActionVia): OpenAction | null => {
    const current = traces();

    const span = current?.start(`polaris.action.${id}`, {
      "polaris.action.id": id,
      "polaris.action.label": label,
      "polaris.action.via": via,
    });

    if (current === null || current === undefined || span === null || span === undefined) {
      return null;
    }

    const previous = open;

    if (previous !== null) {
      previous.adopting = false;
      idle(previous);
    }

    const action: OpenAction = {
      span,
      now: current.now,
      pending: 0,
      lastAt: current.now(),
      adopting: true,
      failure: undefined,
      cancelQuiet: null,
      cancelBound: () => undefined,
      done: false,
    };

    action.cancelBound = arm(() => finish(action), ACTION_BOUND_MS);
    open = action;

    return action;
  };

  const follow = <A>(action: OpenAction, result: Promise<A>) => {
    action.pending += 1;
    result.then(
      () => release(action),
      (cause: unknown) => {
        action.failure = failureOf(cause);
        release(action);
      }
    );
  };

  /** Runs a handler as an action; inside another action's handler it is part of that one. */
  const run = <A>(id: string, label: string, handler: () => A, via: ActionVia = "click"): A => {
    const action = handling ? null : begin(id, label, via);

    if (action === null) return handler();
    handling = true;

    try {
      const result = handler();

      if (result instanceof Promise) follow(action, result);

      return result;
    } catch (cause) {
      action.failure = failureOf(cause);
      throw cause;
    } finally {
      handling = false;
      action.lastAt = action.now();

      if (action.failure === undefined) idle(action);
      else finish(action, action.lastAt);
    }
  };

  /** The open action a request joins, or null when none is taking requests. */
  const adopt = (): ActionChild | null => {
    const action = open;

    if (action === null || !action.adopting) return null;
    action.pending += 1;
    action.cancelQuiet?.();
    action.cancelQuiet = null;

    return { trace: action.span.trace, settle: () => release(action) };
  };

  /** The open action's Span while it hasn't ended, for warnings to join (ENG-754). */
  const active = (): RendererSpan | undefined =>
    open === null || open.done ? undefined : open.span;

  return { run, adopt, active };
};

export type ActionTraces = ReturnType<typeof createActionTraces>;

/** The window's action Spans, on the window's Self-Traces. */
export const actionTraces: ActionTraces = createActionTraces({ traces: selfTraces });

/** Runs `handler` as the action `id` ("data.table.open"), labelled for a reader ("Open table"). */
export const runAction = <A>(id: string, label: string, handler: () => A, via?: ActionVia): A =>
  actionTraces.run(id, label, handler, via);

/** Wraps a click handler so each call is the action `id`. */
export const tracedAction =
  <Args extends ReadonlyArray<unknown>, A>(
    id: string,
    label: string,
    handler: (...args: Args) => A
  ) =>
  (...args: Args): A =>
    actionTraces.run(id, label, () => handler(...args));

const traced = new WeakMap<PolarisApi, PolarisApi>();

/** `api` whose requests join the open action; a request with its own `trace` keeps it. */
export const traceRequests = (api: PolarisApi, actions: ActionTraces = actionTraces) => {
  const known = traced.get(api);

  if (known !== undefined) return known;

  const request: PolarisApi["request"] = (method, input, options) => {
    const child = options?.trace === undefined ? actions.adopt() : null;

    if (child === null) {
      return options === undefined
        ? api.request(method, input)
        : api.request(method, input, options);
    }

    const sent = api.request(method, input, { ...options, trace: child.trace });

    sent.then(child.settle, child.settle);

    return sent;
  };

  // SAFETY: own enumerable keys of a `PolarisApi` are its fields.
  const keys = Object.keys(api) as Array<keyof PolarisApi>;

  // Getters, not a copy: a preview's stand-in may change after this; `request` is the one override.
  const wrapped = Object.defineProperties(
    {},
    Object.fromEntries(
      keys.map((key) => [
        key,
        { enumerable: true, get: () => (key === "request" ? request : api[key]) },
      ])
    )
  );

  // SAFETY: `wrapped` has a getter for each of `api`'s own keys, `request` among them.
  const result = wrapped as PolarisApi;

  traced.set(api, result);

  return result;
};
