/**
 * "Link a device" (Paper D1, D1b; SR-08): a one-time link as a QR code and "Copy link", in
 * a well of Linked devices, waiting for the phone until it links or expires. Never logged.
 */
import { SettingsButton, SettingsWell } from "@polaris/ui";
import { Match } from "effect";
import { useEffect, useRef, useState } from "react";
import type { IpcError } from "../../../shared/api.ts";
import type { LinkOfferView } from "../../../shared/linkedDevicesContract.ts";
import { useNow } from "../../shell/useNow.ts";
import { polaris } from "../bridge.ts";
import { QrCode } from "../extensions/ui/QrCode.tsx";
import { names, timeLeft } from "./model.ts";

export type LinkPanelState =
  | { readonly kind: "closed" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly offer: LinkOfferView }
  | { readonly kind: "ended"; readonly line: string };

/** Copies through the main process, which clears the clipboard after a minute. */
const CopyLink = ({ link }: { readonly link: string }) => {
  const [copied, setCopied] = useState(false);

  return (
    <SettingsButton
      onClick={() =>
        void polaris()
          .request("clipboard.writeSecret", { text: link })
          .then((result) => setCopied(result.ok))
      }
    >
      {copied ? "Copied" : "Copy link"}
    </SettingsButton>
  );
};

const Waiting = ({
  offer,
  labelOf,
  onCancel,
}: {
  readonly offer: LinkOfferView;
  readonly labelOf: (key: string) => string;
  readonly onCancel: () => void;
}) => {
  const now = useNow(1000);
  const reach = names([offer.hostKey, ...offer.shareTo].map(labelOf));

  return (
    <SettingsWell rows={false} className="p-panel flex-row gap-5" data-testid="link-panel">
      <QrCode
        text={offer.linkString}
        size={172}
        label="Link QR code"
        fallback="Copy the link instead."
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-body text-text-default font-medium">
            Scan with Polaris on your phone
          </h3>
          <p className="text-body text-text-subtle">
            It links once and reaches {reach} through the Polaris Relay. The code works once, for 5
            minutes.
          </p>
        </div>
        <div className="border-hairline bg-surface-sunken flex h-8 items-center gap-2 rounded-[6px] border pr-1 pl-2.5">
          <span className="text-caption text-text-default min-w-0 flex-1 truncate font-mono">
            polaris-link:v2:•••
          </span>
          <CopyLink link={offer.linkString} />
        </div>
        <p className="text-caption text-text-subtle">
          No camera? Paste the link into the phone instead. Polaris clears it from the clipboard
          after a minute.
        </p>
        <span className="flex-1" />
        <div className="flex items-center gap-3">
          <span className="text-caption text-text-subtle flex-1">
            Waiting for your phone · {timeLeft(offer.expiresAt, now)}
          </span>
          <SettingsButton variant="ghost" onClick={onCancel}>
            Cancel
          </SettingsButton>
        </div>
      </div>
    </SettingsWell>
  );
};

const endedLine = (error: IpcError) =>
  error.code === "NoRelayHost" ? error.message : `The link ended: ${error.message}`;

/** The link's state, and starting and closing it; a late answer after Cancel is dropped. */
export const useLink = (onLinked: () => void) => {
  const [panel, setPanel] = useState<LinkPanelState>({ kind: "closed" });
  // Each start gets a number; a cancelled one's late answer is dropped.
  const attempt = useRef(0);
  // The link still open on its Host: Cancel and leaving the page end it there too.
  const open = useRef<{ readonly hostKey: string; readonly linkId: string } | null>(null);

  const cancelOpen = () => {
    const link = open.current;
    open.current = null;

    if (link !== null) void polaris().request("devices.cancelLink", link);
  };

  useEffect(
    () => () => {
      attempt.current += 1;
      cancelOpen();
    },
    []
  );

  const start = async () => {
    const mine = ++attempt.current;
    cancelOpen();
    setPanel({ kind: "starting" });

    const offered = await polaris().request("devices.startLink", {});

    if (mine !== attempt.current) return;

    if (!offered.ok) return setPanel({ kind: "ended", line: endedLine(offered.error) });

    const offer = offered.value;
    open.current = { hostKey: offer.hostKey, linkId: offer.linkId };
    setPanel({ kind: "waiting", offer });

    const linked = await polaris().request("devices.finishLink", {
      hostKey: offer.hostKey,
      linkId: offer.linkId,
      shareTo: offer.shareTo,
    });

    if (mine !== attempt.current) return;
    open.current = null;

    if (!linked.ok) return setPanel({ kind: "ended", line: endedLine(linked.error) });

    setPanel({ kind: "closed" });
    onLinked();
  };

  const close = () => {
    attempt.current += 1;
    cancelOpen();
    setPanel({ kind: "closed" });
  };

  return { panel, start: () => void start(), close };
};

/** The link's well while it opens, waits, or after it ended; nothing while closed. */
export const LinkPanel = ({
  panel,
  labelOf,
  onCancel,
}: {
  readonly panel: LinkPanelState;
  readonly labelOf: (key: string) => string;
  readonly onCancel: () => void;
}) =>
  Match.value(panel).pipe(
    Match.discriminatorsExhaustive("kind")({
      closed: () => null,
      starting: () => (
        <SettingsWell rows={false} className="px-panel py-3">
          <p className="text-caption text-text-subtle" role="status">
            Opening a link…
          </p>
        </SettingsWell>
      ),
      waiting: ({ offer }) => <Waiting offer={offer} labelOf={labelOf} onCancel={onCancel} />,
      ended: ({ line }) => (
        <SettingsWell rows={false} className="px-panel py-3">
          <p className="text-caption text-text-subtle">{line}</p>
        </SettingsWell>
      ),
    })
  );
