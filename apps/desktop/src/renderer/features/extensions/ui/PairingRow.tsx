/** A Pairing in its host's card (Paper SR-07): its Grant, last use, and Revoke confirmed in place. */
import type { Pairing } from "@polaris/protocol";
import { SettingsConfirmRow } from "@polaris/ui";
import { useState } from "react";
import type { Plain } from "../../../../shared/api.ts";
import { grantLine, usedLine } from "../model.ts";

export const PairingRow = ({
  pairing,
  now,
  onRevoke,
}: {
  readonly pairing: Plain<Pairing>;
  readonly now: number;
  readonly onRevoke: () => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);

  return (
    <div data-testid="pairing-row">
      <SettingsConfirmRow
        title={pairing.name}
        caption={grantLine(pairing.grant)}
        action="Revoke"
        actionVariant="secondary"
        consequence="Revoking disconnects it now. To use it again, pair it again."
        confirm={`Revoke ${pairing.name}`}
        onConfirm={() => {
          setBusy(true);
          void onRevoke().finally(() => setBusy(false));
        }}
        {...(busy ? { disabledReason: "Revoking…" } : {})}
      >
        <span className="text-text-subtle font-mono text-[11px] leading-4 whitespace-nowrap">
          {usedLine(pairing, now)}
        </span>
      </SettingsConfirmRow>
    </div>
  );
};
