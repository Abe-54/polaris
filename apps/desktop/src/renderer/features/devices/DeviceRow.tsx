/** A Linked Device (Paper SR-08): when it was linked and last seen, Retry, and Unlink in place. */
import { SettingsButton, SettingsConfirmRow } from "@polaris/ui";
import { useState } from "react";
import { type DeviceSummary, deviceCaption } from "./model.ts";

export const DeviceRow = ({
  device,
  now,
  onUnlink,
  onRetry,
}: {
  readonly device: DeviceSummary;
  readonly now: number;
  readonly onUnlink: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
}) => {
  const [busy, setBusy] = useState<string | null>(null);

  const run = (reason: string, action: () => Promise<void>) => {
    setBusy(reason);
    void action().finally(() => setBusy(null));
  };

  return (
    <div data-testid="device-row">
      <SettingsConfirmRow
        title={device.name}
        caption={deviceCaption(device, now)}
        action="Unlink"
        actionVariant="secondary"
        consequence="Unlinking cuts it off from every host now. To use it again, link it again."
        confirm={`Unlink ${device.name}`}
        onConfirm={() => run("Unlinking…", onUnlink)}
        {...(busy === null ? {} : { disabledReason: busy })}
      >
        {device.notShared.length > 0 ? (
          <SettingsButton
            variant="ghost"
            disabled={busy !== null}
            onClick={() => run("Sharing…", onRetry)}
          >
            Retry
          </SettingsButton>
        ) : null}
      </SettingsConfirmRow>
    </div>
  );
};
