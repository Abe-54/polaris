/**
 * Paper Q3's cards side by side, for screenshots (`#requests/states`): the Origin Approval and the
 * empty checkout. The refused and no-spans states show in the real send pane (scenes.ts).
 */
import { useMemo } from "react";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import { OriginApprovalCard } from "../approval/OriginApprovalCard.tsx";
import type { RequestsSessionKey } from "../model/session.ts";
import { EmptyCheckout } from "../ui/states/EmptyCheckout.tsx";
import { fixtureOriginApproval, STAGING_POST } from "./approvalFixtures.ts";

export const StatesGallery = ({ at }: { readonly at: RequestsSessionKey }) => {
  const request = useMemo(() => fixtureOriginApproval(FIXTURE_SESSION, "r-gallery"), []);

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
      <EmptyCheckout
        at={at}
        hostKey={at.hostKey}
        workspaceId="w-ledger"
        onNew={() => undefined}
        onPasteCurl={() => undefined}
      />
    </div>
  );
};
