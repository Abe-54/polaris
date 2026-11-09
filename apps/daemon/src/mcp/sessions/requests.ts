/** An agent's Sends: checkout and Turn come from the authenticated session, never tool arguments. */
import {
  NotFound,
  RequestsError,
  SendLookup,
  type RequestId,
  type RequestTarget,
  type SessionId,
} from "@polaris/protocol";
import { Effect } from "effect";
import type { EventStore } from "../../store/EventStore.ts";
import { workingTurn } from "../../store/model.ts";
import { OriginGrant, type OriginApprovals } from "../../requests/approvals/index.ts";
import type { RequestSends } from "../../requests/sendsService.ts";

export type RequestSessionTools = ReturnType<typeof sessionRequestTools>;

/** What one call key last led to: an approval it waits on, or the Send it made. */
export type SendMemo = { readonly approvalId: RequestId } | { readonly sendId: string };

const KEPT = 256;

export const sessionRequestTools = (
  store: EventStore["Service"],
  sends: RequestSends["Service"],
  approvals: OriginApprovals["Service"]
) => {
  const memos = new Map<string, SendMemo>();

  const context = Effect.fnUntraced(function* (sessionId: SessionId) {
    const record = (yield* store.model).sessions.get(sessionId);

    if (record === undefined) return yield* new NotFound({ what: "Agent session", id: sessionId });
    const turn = workingTurn(record)?.id;

    if (turn === undefined)
      return yield* new RequestsError({
        code: "E-INPUT",
        message: "This agent session has no turn in flight.",
        fix: "Call send_request from within a turn.",
      });

    return { checkout: record.session.cwd, turn };
  });

  return {
    send: Effect.fnUntraced(function* (
      sessionId: SessionId,
      target: RequestTarget,
      environment: string | undefined,
      grant: RequestId | null
    ) {
      const { checkout, turn } = yield* context(sessionId);

      return yield* sends
        .send({
          checkout,
          target,
          ...(environment === undefined ? undefined : { environment }),
          by: { kind: "agent", sessionId, turn },
        })
        .pipe(Effect.provideService(OriginGrant, grant));
    }),
    get: Effect.fnUntraced(function* (sessionId: SessionId, id: string) {
      const { checkout } = yield* context(sessionId);

      return yield* sends.get(checkout, SendLookup.cases.ById.make({ id }));
    }),
    awaitApproval: approvals.awaitApproval,
    recall: (key: string) => memos.get(key),
    remember: (key: string, memo: SendMemo) => {
      memos.delete(key);
      memos.set(key, memo);

      for (const oldest of memos.keys()) {
        if (memos.size <= KEPT) break;
        memos.delete(oldest);
      }
    },
  };
};
