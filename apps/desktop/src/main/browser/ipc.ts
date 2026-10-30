/** The `browser.*` requests and the `browser.tabs` feed in `browserContract.ts`. */
import { Effect, Queue, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type {
  BrowserRequestInputs,
  BrowserSubscriptionInputs,
  BrowserTabEvent,
} from "../../shared/browserContract.ts";
import type { Feed } from "../ipc/feeds.ts";
import type { Handler } from "../ipc/requests.ts";
import { BrowserTabOpener } from "../../shared/browserContract.ts";
import { BrowserRefused, type Registry } from "./registry.ts";

const UNAVAILABLE: IpcError = { code: "Unavailable", message: "The Browser isn't available" };

const failure = (cause: unknown): IpcError => ({
  code: cause instanceof BrowserRefused ? cause.code : "Defect",
  message: cause instanceof Error ? cause.message : String(cause),
});

type Handlers = { readonly [M in keyof typeof BrowserRequestInputs]: Handler<M> };

export const browserHandlers = (browsers: Registry | undefined): Handlers => {
  const act =
    <I, A>(use: (b: Registry, input: I) => A) =>
    (input: I) =>
      browsers === undefined
        ? Effect.fail(UNAVAILABLE)
        : Effect.try({ try: () => use(browsers, input), catch: failure });

  const done =
    <I>(use: (b: Registry, input: I) => void) =>
    (input: I) =>
      Effect.as(act(use)(input), null);

  return {
    "browser.openTab": ({ hostKey, workspaceId, sessionId, url }) =>
      browsers === undefined
        ? Effect.fail(UNAVAILABLE)
        : Effect.tryPromise({
            try: () =>
              browsers.openTab({
                hostKey,
                workspaceId,
                sessionId,
                url,
                openedBy: BrowserTabOpener.cases.User.make({}),
              }),
            catch: failure,
          }),
    "browser.closeTab": done((b, { hostKey, sessionId, tabId }) =>
      b.closeTab(hostKey, sessionId, tabId)
    ),
    "browser.activateTab": done((b, { hostKey, sessionId, tabId }) =>
      b.activateTab(hostKey, sessionId, tabId)
    ),
    "browser.navigate": done((b, { hostKey, sessionId, tabId, url }) =>
      b.navigate(hostKey, sessionId, tabId, url)
    ),
    "browser.back": done((b, { hostKey, sessionId, tabId }) => b.back(hostKey, sessionId, tabId)),
    "browser.forward": done((b, { hostKey, sessionId, tabId }) =>
      b.forward(hostKey, sessionId, tabId)
    ),
    "browser.reload": done((b, { hostKey, sessionId, tabId, ignoreCache }) =>
      b.reload(hostKey, sessionId, tabId, ignoreCache)
    ),
    "browser.devtools": done((b, { hostKey, sessionId, tabId, open }) =>
      b.devtools(hostKey, sessionId, tabId, open)
    ),
    "browser.listTabs": act((b, { hostKey, sessionId }) => b.sessionTabs(hostKey, sessionId).tabs),
    "browser.show": done((b, { hostKey, sessionId, bounds }) => b.show(hostKey, sessionId, bounds)),
    "browser.hide": done((b, { hostKey, sessionId }) => b.hide(hostKey, sessionId)),
    "browser.forget": done((b, { hostKey, sessionIds }) => b.forget(hostKey, sessionIds)),
    "browser.working": done((b, { sessions }) => b.setWorking(sessions)),
    "browser.pick": ({ hostKey, sessionId, tabId }) =>
      browsers === undefined
        ? Effect.fail(UNAVAILABLE)
        : Effect.tryPromise({
            try: () => browsers.pick(hostKey, sessionId, tabId),
            catch: failure,
          }),
    "browser.cancelPick": done((b, { hostKey, sessionId, tabId }) =>
      b.cancelPick(hostKey, sessionId, tabId)
    ),
  };
};

type Openers = {
  readonly [K in keyof typeof BrowserSubscriptionInputs]: (
    input: (typeof BrowserSubscriptionInputs)[K]["Type"]
  ) => Feed<K>;
};

export const browserOpeners = (browsers: Registry | undefined): Openers => ({
  "browser.tabs": ({ hostKey, sessionId }) =>
    browsers === undefined
      ? Stream.fail(UNAVAILABLE)
      : Stream.callback<BrowserTabEvent, IpcError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              browsers.subscribe(hostKey, sessionId, (event) => Queue.offerUnsafe(queue, event))
            ),
            (unsubscribe) => Effect.sync(unsubscribe)
          )
        ),
});
