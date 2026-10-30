/**
 * A browser-level CDP endpoint over one Agent Session's tabs (ENG-616, ADR 0092): the target
 * methods agent-browser needs, scoped to the session, over each tab's `webContents.debugger`;
 * page methods pass through under the facade's session ids. One facade per relay stream.
 */
import type { CdpError, CdpJson, CdpMessage, SessionId } from "@polaris/protocol";
import { Match, Option, Schema } from "effect";
import {
  BrowserTab,
  type BrowserTabEvent,
  BrowserTabId,
  BrowserTabOpener,
} from "../../shared/browserContract.ts";
import { drives } from "./driving.ts";
import { hubOf } from "./hub.ts";
import type { CdpTabs } from "./ports.ts";
import { decodeHandle, refusalOf, tabRefusalOf } from "./refusals.ts";

/** Commands awaiting a tab's answer before the facade closes the stream on a flooding agent. */
export const MAX_COMMANDS_IN_FLIGHT = 256;

import { Targets } from "./targets.ts";

export interface CdpVersions {
  readonly chrome: string;
  readonly v8: string;
  readonly userAgent: string;
}

export interface CdpFacadeInput {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly tabs: CdpTabs;
  /** A message for the agent, or for the relay (`Polaris.*`). */
  readonly send: (message: CdpMessage) => void;
  readonly versions: CdpVersions;
  /** The agent overran a bound; the facade has closed itself and the stream should end. */
  readonly overflow?: (reason: string) => void;
}

export interface CdpFacade {
  /** A message from the agent, or from the relay (`Polaris.hello`). */
  readonly receive: (message: CdpMessage) => void;
  /** Detaches from every tab; the facade sends nothing after. */
  readonly close: () => void;
}

/** A CDP error reply: `code` as Chromium uses them. */
export class CdpCommandError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

const Command = Schema.Struct({
  id: Schema.Int,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
  sessionId: Schema.optionalKey(Schema.String),
});

type Command = typeof Command.Type;

const Hello = Schema.Struct({ tabs: Schema.Array(Schema.Struct({ url: Schema.String })) });

const WithTargetId = Schema.Struct({ targetId: Schema.String });

const MaybeTargetId = Schema.Struct({ targetId: Schema.optionalKey(Schema.String) });

const Attach = Schema.Struct({
  targetId: Schema.String,
  flatten: Schema.optionalKey(Schema.Boolean),
});

const WithSessionId = Schema.Struct({ sessionId: Schema.String });

const Navigate = Schema.Struct({ url: Schema.String });

const WithStream = Schema.Struct({ stream: Schema.String });

const NestedAttached = Schema.Struct({
  sessionId: Schema.String,
  targetInfo: Schema.Struct({ type: Schema.String }),
});

const Discover = Schema.Struct({ discover: Schema.Boolean });

const AutoAttach = Schema.Struct({ autoAttach: Schema.Boolean });

const Create = Schema.Struct({ url: Schema.optionalKey(Schema.String) });

const decode = {
  command: Schema.decodeUnknownOption(Command),
  hello: Schema.decodeUnknownOption(Hello),
  targetId: Schema.decodeUnknownOption(WithTargetId),
  maybeTargetId: Schema.decodeUnknownOption(MaybeTargetId),
  attach: Schema.decodeUnknownOption(Attach),
  sessionId: Schema.decodeUnknownOption(WithSessionId),
  navigate: Schema.decodeUnknownOption(Navigate),
  stream: Schema.decodeUnknownOption(WithStream),
  nestedAttached: Schema.decodeUnknownOption(NestedAttached),
  discover: Schema.decodeUnknownOption(Discover),
  autoAttach: Schema.decodeUnknownOption(AutoAttach),
  create: Schema.decodeUnknownOption(Create),
};

const invalidParams = (method: string) =>
  new CdpCommandError(-32602, `Invalid parameters for ${method}`);

const noTarget = () => new CdpCommandError(-32000, "No target with given id found");

const noSession = () => new CdpCommandError(-32001, "Session with given id not found.");

const params = <A>(decoded: Option.Option<A>, method: string): A => {
  if (Option.isNone(decoded)) throw invalidParams(method);

  return decoded.value;
};

/** Target methods the facade answers itself, whichever session the agent sends them on. */
const FACADE_TARGET_METHODS = new Set([
  "Target.setDiscoverTargets",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
]);

const browserLevelOnly = (method: string) =>
  `${method} is not available at the browser level through this Browser: attach to one of this session's tabs.`;

const failure = (error: Error): CdpError =>
  error instanceof CdpCommandError
    ? { code: error.code, message: error.message }
    : { code: -32000, message: error.message };

type Handler = (command: Command) => Promise<CdpJson> | CdpJson;

const changedTab = (
  tab: BrowserTab,
  change: Extract<BrowserTabEvent, { _tag: "Changed" }>
): BrowserTab =>
  new BrowserTab({
    tabId: tab.tabId,
    sessionId: tab.sessionId,
    openedBy: tab.openedBy,
    url: change.url,
    title: change.title,
    loading: change.loading,
    canGoBack: change.canGoBack,
    canGoForward: change.canGoForward,
    hostAddress: change.hostAddress,
    agentDriving: change.agentDriving,
  });

/** A facade over `sessionId`'s tabs; `send` carries its messages to the relay. */
export const cdpFacade = (input: CdpFacadeInput): CdpFacade => {
  const { hostKey, sessionId, tabs, send } = input;
  const targets = new Targets(sessionId);
  const handles = new Set<string>();
  let discover = false;
  let autoAttach = false;
  let closed = false;
  let inFlight = 0;

  const emit = (message: CdpMessage) => {
    if (!closed) send(message);
  };

  const report = () =>
    emit({
      method: "Polaris.tabs",
      params: {
        tabs: Array.from(targets.known.values(), (tab) => ({
          targetId: tab.tabId,
          url: tab.url,
          title: tab.title ?? "",
        })),
      },
    });

  const tabOf = (targetId: string): BrowserTab => {
    const tab = targets.known.get(BrowserTabId.make(targetId));

    if (tab === undefined) throw noTarget();

    return tab;
  };

  const detach = (session: string, announce: boolean) => {
    const gone = targets.detach(session);

    if (gone === null) return;

    if (gone.hub.size() === 0) tabs.setAgentDriving(gone.tabId, false);

    if (announce)
      emit({
        method: "Target.detachedFromTarget",
        params: { sessionId: session, targetId: gone.tabId },
      });
  };

  const onTabMessage = (
    session: string,
    method: string,
    message: CdpJson,
    nestedSessionId: string
  ) => {
    const nested = decode.sessionId(message);
    const attached = decode.nestedAttached(message);

    // Only what Chromium opened under the tab (frames, workers) routes; never a browser target.
    if (method === "Target.attachedToTarget" && Option.isSome(attached)) {
      if (attached.value.targetInfo.type !== "browser")
        targets.nestedOpened(session, attached.value.sessionId);
    } else if (method === "Target.detachedFromTarget" && Option.isSome(nested))
      targets.nestedClosed(nested.value.sessionId);
    emit({
      method,
      params: message,
      sessionId: nestedSessionId === "" ? session : nestedSessionId,
    });
  };

  const attach = (tab: BrowserTab): string => {
    const existing = targets.attachedTo(tab.tabId);

    if (existing !== null) return existing;
    const debuggee = tabs.debuggeeOf(tab.tabId);

    if (debuggee === null) throw noTarget();
    const hub = hubOf(debuggee);
    let session = "";

    const release = hub.acquire({
      message: (method, message, nested) => onTabMessage(session, method, message, nested),
      detached: () => detach(session, true),
    });

    session = targets.attached(tab.tabId, hub, release);
    emit({
      method: "Target.attachedToTarget",
      params: { sessionId: session, targetInfo: targets.infoOf(tab), waitingForDebugger: false },
    });

    return session;
  };

  const tabOpened = (tab: BrowserTab) => {
    if (targets.known.has(tab.tabId)) return;
    targets.known.set(tab.tabId, tab);

    if (discover)
      emit({ method: "Target.targetCreated", params: { targetInfo: targets.infoOf(tab) } });

    if (autoAttach) attach(tab);
  };

  const tabClosed = (tabId: BrowserTabId) => {
    if (!targets.known.delete(tabId)) return;
    targets.sessionsOn(tabId).forEach((session) => detach(session, true));

    if (discover) emit({ method: "Target.targetDestroyed", params: { targetId: tabId } });
  };

  const onTabEvent = (event: BrowserTabEvent) => {
    Match.valueTags(event, {
      Snapshot: ({ tabs: now }) => {
        const ids = new Set(now.map((tab) => tab.tabId));

        for (const tabId of Array.from(targets.known.keys())) if (!ids.has(tabId)) tabClosed(tabId);
        now.forEach(tabOpened);
      },
      Opened: ({ tab }) => tabOpened(tab),
      Changed: (change) => {
        const tab = targets.known.get(change.tabId);

        if (tab === undefined) return;
        const next = changedTab(tab, change);
        targets.known.set(change.tabId, next);

        if (discover)
          emit({
            method: "Target.targetInfoChanged",
            params: { targetInfo: targets.infoOf(next) },
          });
      },
      Activated: () => undefined,
      Closed: ({ tabId }) => tabClosed(tabId),
    });
    report();
  };

  const unsubscribe = tabs.subscribe(hostKey, sessionId, onTabEvent);
  tabs.sessionTabs(hostKey, sessionId).forEach(tabOpened);

  const browserHandlers = new Map<string, Handler>(
    Object.entries({
      "Browser.getVersion": () => ({
        protocolVersion: "1.3",
        product: `Chrome/${input.versions.chrome}`,
        revision: "",
        userAgent: input.versions.userAgent,
        jsVersion: input.versions.v8,
      }),
      "Browser.setDownloadBehavior": () => ({}),
      "Target.setAutoAttach": (command) => {
        autoAttach = params(decode.autoAttach(command.params), command.method).autoAttach;

        if (autoAttach) for (const tab of targets.known.values()) attach(tab);

        return {};
      },
      "Target.setDiscoverTargets": (command) => {
        discover = params(decode.discover(command.params), command.method).discover;

        if (discover)
          for (const tab of targets.known.values())
            emit({ method: "Target.targetCreated", params: { targetInfo: targets.infoOf(tab) } });

        return {};
      },
      "Target.getTargets": () => ({ targetInfos: [...targets.infos()] }),
      "Target.getTargetInfo": (command) => {
        const { targetId } = params(decode.maybeTargetId(command.params), command.method);
        const tab = targetId === undefined ? targets.known.values().next().value : tabOf(targetId);

        if (tab === undefined) throw noTarget();

        return { targetInfo: targets.infoOf(tab) };
      },
      "Target.attachToTarget": (command) => {
        const { targetId, flatten } = params(decode.attach(command.params), command.method);

        if (flatten === false)
          throw new CdpCommandError(
            -32000,
            "This Browser attaches in flatten mode only: pass flatten: true."
          );

        return { sessionId: attach(tabOf(targetId)) };
      },
      "Target.detachFromTarget": (command) => {
        const { sessionId: session } = params(decode.sessionId(command.params), command.method);

        if (targets.routeOf(session) === null) throw noSession();
        detach(session, false);

        return {};
      },
      "Target.createTarget": async (command) => {
        const { url } = params(decode.create(command.params), command.method);

        const tab = await tabs.openTab({
          hostKey,
          sessionId,
          url: url === undefined || url === "" ? "about:blank" : url,
          openedBy: BrowserTabOpener.cases.Agent.make({}),
        });

        // The agent left while its tab opened: nothing attaches, and the tab goes with it.
        if (closed) {
          await tabs.closeTab({ hostKey, sessionId, tabId: tab.tabId }).catch(() => undefined);
          throw new CdpCommandError(-32000, "The Browser closed");
        }

        tabOpened(tab);
        tabs.setAgentDriving(tab.tabId, true);

        return { targetId: tab.tabId };
      },
      "Target.closeTarget": async (command) => {
        const tab = tabOf(params(decode.targetId(command.params), command.method).targetId);
        await tabs.closeTab({ hostKey, sessionId, tabId: tab.tabId });

        return { success: true };
      },
      "Target.activateTarget": async (command) => {
        const tab = tabOf(params(decode.targetId(command.params), command.method).targetId);
        await tabs.activateTab({ hostKey, sessionId, tabId: tab.tabId });

        return {};
      },
    } satisfies Record<string, Handler>)
  );

  const reply = (command: Command, body: Pick<CdpMessage, "result" | "error">) =>
    emit(
      command.sessionId === undefined
        ? { id: command.id, ...body }
        : { id: command.id, sessionId: command.sessionId, ...body }
    );

  const overflow = (reason: string) => {
    if (closed) return;
    closed = true;
    unsubscribe();
    targets.allSessions().forEach((session) => detach(session, false));
    input.overflow?.(reason);
  };

  const run = async (command: Command, body: () => Promise<CdpJson> | CdpJson) => {
    if (inFlight >= MAX_COMMANDS_IN_FLIGHT)
      return overflow(`${MAX_COMMANDS_IN_FLIGHT} commands awaiting answers`);
    inFlight += 1;

    try {
      const result = await body();
      // Streams a tab hands out (response bodies, PDFs) are the only ones IO may read.
      const stream = decode.stream(result);

      if (Option.isSome(stream)) handles.add(stream.value.stream);
      reply(command, { result });
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      reply(command, { error: failure(error) });
    } finally {
      inFlight -= 1;
    }
  };

  const dispatch = (command: Command) => {
    const refusal =
      command.sessionId === undefined
        ? refusalOf(command.method, command.params)
        : tabRefusalOf(command.method, command.params, handles);

    if (refusal !== null) return reply(command, { error: { code: -32000, message: refusal } });
    const handler = browserHandlers.get(command.method);

    if (
      handler !== undefined &&
      (command.sessionId === undefined || FACADE_TARGET_METHODS.has(command.method))
    )
      return void run(command, () => handler(command));

    if (command.sessionId === undefined)
      return reply(command, { error: { code: -32601, message: browserLevelOnly(command.method) } });

    if (command.method === "Page.navigate") {
      const url = Option.map(decode.navigate(command.params), (p) => p.url);

      if (Option.isNone(url) || !tabs.allowsUrl(url.value))
        return reply(command, {
          error: { code: -32000, message: `A tab can't open ${Option.getOrElse(url, () => "")}` },
        });
    }

    const route = targets.routeOf(command.sessionId);

    if (route === null) return reply(command, { error: failure(noSession()) });

    if (drives(command.method)) tabs.setAgentDriving(route.tabId, true);

    if (command.method === "IO.close") {
      const handle = decodeHandle(command.params);

      if (Option.isSome(handle)) handles.delete(handle.value.handle);
    }

    return void run(command, () =>
      route.hub.send(command.method, command.params ?? {}, route.nested ?? undefined)
    );
  };

  const hello = async (message: CdpJson | undefined) => {
    const decoded = decode.hello(message);

    if (Option.isSome(decoded) && targets.known.size === 0 && !tabs.hasTabs(hostKey, sessionId))
      for (const { url } of decoded.value.tabs) {
        try {
          const tab = await tabs.openTab({
            hostKey,
            sessionId,
            url,
            openedBy: BrowserTabOpener.cases.User.make({}),
          });

          // Reopened for the user, so a tab stays even when the agent is gone; just don't attach.
          if (closed) return;
          tabOpened(tab);
        } catch {
          // A URL the Browser refuses now stays closed; the rest still reopen.
        }
      }

    report();
  };

  const receive = (message: CdpMessage) => {
    if (closed) return;
    const command = decode.command(message);

    if (Option.isSome(command)) {
      dispatch(command.value);

      return;
    }

    if (message.method === "Polaris.hello") {
      void hello(message.params);

      return;
    }

    if (message.method?.startsWith("Polaris.")) return;
    emit({
      id: message.id ?? null,
      error: { code: -32600, message: "Message must have integer 'id' property" },
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    targets.allSessions().forEach((session) => detach(session, false));
  };

  return { receive, close };
};
