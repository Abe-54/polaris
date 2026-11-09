/**
 * Where U3's outcome states go (features/requests/ui/states/): SendFailure in place of the
 * response for a send that got none, and NoSpans under TRACE when only the send span came back.
 */
import type { Send } from "@polaris/protocol";
import type { RequestsSessionKey } from "../../model/session.ts";

export const SendFailureSlot = ({
  send,
}: {
  readonly send: Send;
  readonly onSendAgain: () => void;
}) => (
  <p className="text-caption text-text-subtle px-panel pb-2" data-testid="send-failure">
    {send.errorMessage ?? "No response"}
  </p>
);

export const NoSpansSlot = (_props: { readonly at: RequestsSessionKey }) => (
  <p className="text-caption text-text-faint px-panel py-1.5" data-testid="send-no-spans">
    The server sent no spans for this send.
  </p>
);
