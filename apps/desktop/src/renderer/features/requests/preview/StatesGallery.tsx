/**
 * Paper Q3's cards side by side, for screenshots (`#requests/states`): the Origin Approval, a Send
 * with no spans (inside a stand-in for U2's send pane), a refused connection, and the empty checkout.
 */
import { useMemo } from "react";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import { OriginApprovalCard } from "../approval/OriginApprovalCard.tsx";
import type { RequestsSessionKey } from "../model/session.ts";
import { isFailedSend } from "../model/states.ts";
import { EmptyCheckout } from "../ui/states/EmptyCheckout.tsx";
import { NoSpans } from "../ui/states/NoSpans.tsx";
import { SendFailure } from "../ui/states/SendFailure.tsx";
import { fixtureOriginApproval, STAGING_POST } from "./approvalFixtures.ts";
import { fixtureSend } from "./sendLogFixtures.ts";

const WORKSPACE = "w-ledger";

export const StatesGallery = ({ at }: { readonly at: RequestsSessionKey }) => {
  const request = useMemo(() => fixtureOriginApproval(FIXTURE_SESSION, "r-gallery"), []);

  const refused = useMemo(
    () =>
      fixtureSend(
        {
          id: "e5b4a6f8",
          minutesAgo: 3,
          method: "GET",
          url: "http://localhost:4000/healthz",
          outcome: "refused",
          durationMs: 3,
        },
        Date.now()
      ),
    []
  );

  const slot = { at, hostKey: at.hostKey, workspaceId: WORKSPACE };

  return (
    <div className="bg-ground text-text-default flex min-h-screen flex-wrap content-start items-start gap-6 p-10">
      <OriginApprovalCard
        hostKey={at.hostKey}
        request={request}
        target={STAGING_POST}
        who="Fix overdue totals"
        turn={12}
        hostLabel="Mac Studio"
      />
      <section className="rounded-card border-hairline bg-surface-raised flex w-[420px] flex-col gap-3 border p-4">
        <p className="text-caption text-text-subtle font-mono">
          send pane (U2) · 200 OK · TRACE 1 span
        </p>
        <NoSpans {...slot} onOpenTraces={() => undefined} />
      </section>
      <div className="w-[420px]">
        {isFailedSend(refused) ? (
          <SendFailure
            {...slot}
            send={refused}
            source={{ variable: "base", environment: "dev" }}
            onSendAgain={() => undefined}
          />
        ) : null}
      </div>
      <EmptyCheckout {...slot} onNew={() => undefined} onPasteCurl={() => undefined} />
    </div>
  );
};
