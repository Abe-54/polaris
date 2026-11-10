/**
 * A fake `window.polaris` for renderer tests: it records every request and answers each
 * method as the test set it (ok with null otherwise), and keeps each feed opened so a test
 * can push items into it. Install it in `beforeEach`.
 */
import type {
  IpcError,
  PolarisApi,
  RequestInput,
  RequestMethod,
  RequestOutput,
  Result,
  SubscriptionItem,
  SubscriptionListener,
} from "../../shared/api.ts";
import type { SubscriptionInput, SubscriptionKind } from "../../shared/contract.ts";
import { standInBridge } from "../features/bridge.ts";

type Answerer<M extends RequestMethod> = (
  input: RequestInput<M>
) => Result<RequestOutput<M>> | Promise<Result<RequestOutput<M>>>;

type Call = { readonly [M in RequestMethod]: readonly [M, RequestInput<M>] }[RequestMethod];

/** A feed the code under test opened. */
export interface Feed<K extends SubscriptionKind> {
  readonly kind: K;
  readonly input: SubscriptionInput<K>;
  readonly listener: SubscriptionListener<SubscriptionItem<K>>;
  /** The code under test closed it. */
  readonly closed: () => boolean;
}

type AnyFeed = { readonly [K in SubscriptionKind]: Feed<K> }[SubscriptionKind];

export interface FakeBridge {
  /** Every request, in order. */
  readonly calls: ReadonlyArray<Call>;
  /** The inputs sent to `method`, in order. */
  readonly sent: <M extends RequestMethod>(method: M) => ReadonlyArray<RequestInput<M>>;
  /** The methods requested, in order. */
  readonly methods: () => ReadonlyArray<RequestMethod>;
  /** Answers `method` with `answerer` from now on. */
  readonly answer: <M extends RequestMethod>(method: M, answerer: Answerer<M>) => void;
  readonly answerOk: <M extends RequestMethod>(method: M, value: RequestOutput<M>) => void;
  readonly refuse: <M extends RequestMethod>(method: M, error: IpcError) => void;
  /** The feeds of `kind` opened so far, in order. */
  readonly feeds: <K extends SubscriptionKind>(kind: K) => ReadonlyArray<Feed<K>>;
}

/** Installs a fresh fake as the bridge; `standInBridge(null)` removes it. */
export const installFakeBridge = (): FakeBridge => {
  const calls: Array<Call> = [];
  const feeds: Array<AnyFeed> = [];
  const answers = new Map<RequestMethod, (input: never) => ReturnType<Answerer<RequestMethod>>>();

  const answer = <M extends RequestMethod>(method: M, answerer: Answerer<M>) => {
    answers.set(method, answerer);
  };

  standInBridge({
    // SAFETY: each method's answerer was set for that method, so its output is that method's.
    request: (async (method: RequestMethod, input: never) => {
      // SAFETY: the method and its input arrive together from a typed `request` call.
      calls.push([method, input] as Call);

      return (await answers.get(method)?.(input)) ?? { ok: true, value: null };
    }) as PolarisApi["request"],
    subscribe: (kind, input, listener) => {
      let closed = false;

      // SAFETY: the kind, input and listener arrive together from a typed `subscribe` call.
      feeds.push({ kind, input, listener, closed: () => closed } as AnyFeed);

      return () => {
        closed = true;
      };
    },
    onAppEvent: () => () => undefined,
  });

  return {
    calls,
    // SAFETY: a call's input is the input of the method it is paired with.
    sent: (method) => calls.flatMap(([m, input]) => (m === method ? [input as never] : [])),
    methods: () => calls.map(([m]) => m),
    answer,
    answerOk: (method, value) => answer(method, () => ({ ok: true, value })),
    refuse: (method, error) => answer(method, () => ({ ok: false, error })),
    // SAFETY: a feed's listener and input are those of the kind it is paired with.
    feeds: (kind) => feeds.flatMap((feed) => (feed.kind === kind ? [feed as never] : [])),
  };
};
