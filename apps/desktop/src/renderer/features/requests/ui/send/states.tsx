/**
 * U3's outcome states in the send pane (features/requests/ui/states/): SendFailure in place of the
 * response for a send that got none, and NoSpans under TRACE when only the send span came back.
 */
import type { Send } from "@polaris/protocol";
import { useSelection } from "../../../../shell/hooks.ts";
import { leadingVariable, isFailedSend } from "../../model/states.ts";
import type { RequestsSessionKey } from "../../model/session.ts";
import { useRequestsView } from "../../model/store.ts";
import { NoSpans } from "../states/NoSpans.tsx";
import { SendFailure } from "../states/SendFailure.tsx";

/** The pane's slot props: the Workspace is the selection's, as Requests shows it. */
const useSlot = (at: RequestsSessionKey) => ({
  at,
  hostKey: at.hostKey,
  workspaceId: useSelection().workspaceId ?? "",
});

export const SendFailureSlot = ({
  at,
  send,
  onSendAgain,
}: {
  readonly at: RequestsSessionKey;
  readonly send: Send;
  readonly onSendAgain: () => void;
}) => {
  const slot = useSlot(at);
  const view = useRequestsView(at);
  const url = view.open === null ? null : (view.drafts[view.open]?.url ?? null);

  if (!isFailedSend(send)) return null;

  return (
    <SendFailure
      {...slot}
      send={send}
      source={{
        variable: url === null ? null : leadingVariable(url),
        environment: send.environment ?? view.environment,
      }}
      onSendAgain={onSendAgain}
    />
  );
};

export const NoSpansSlot = ({ at }: { readonly at: RequestsSessionKey }) => (
  <div className="px-panel pt-1.5 pb-1">
    <NoSpans {...useSlot(at)} />
  </div>
);
