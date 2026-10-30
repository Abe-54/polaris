/**
 * Settings → Devices (DESIGN.md, Settings redesign SR-08; ENG-461): the reach map from linked
 * devices through the Polaris Relay to each host, then the linked devices, Link a device and Unlink.
 */
import {
  SettingsButton,
  SettingsCard,
  SettingsEmpty,
  SettingsPage,
  SettingsWell,
} from "@polaris/ui";
import type { HostView } from "../../../shared/api.ts";
import { useApp, useShellActions } from "../../shell/hooks.ts";
import { useNow } from "../../shell/useNow.ts";
import { sectionInfo } from "../settings/model/sections.ts";
import { DeviceRow } from "./DeviceRow.tsx";
import { LinkPanel, useLink } from "./LinkPanel.tsx";
import { devicesOf, takesDevices } from "./model.ts";
import { ReachMap } from "./ReachMap.tsx";
import { reachLine } from "./reach.ts";
import { useDevices } from "./useDevices.ts";

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

/** The page for `hosts`; "Turn on" and "Open hosts" call `onOpenHosts`. */
export const Devices = ({
  hosts,
  onOpenHosts: toHosts,
}: {
  readonly hosts: ReadonlyArray<HostView>;
  readonly onOpenHosts: () => void;
}) => {
  const { relays, reload, unlink, share } = useDevices(hosts);
  const link = useLink(reload);
  const now = useNow();
  const info = sectionInfo("devices");
  const devices = devicesOf(relays);
  const labelOf = (key: string) => hosts.find((h) => h.key === key)?.label ?? key;

  const colourOf = (key: string) =>
    hosts.find((h) => h.key === key)?.colour ?? "var(--color-text-subtle)";

  const canLink = relays.some((h) => takesDevices(h) && h.route.connected);
  const linking = link.panel.kind === "starting" || link.panel.kind === "waiting";

  return (
    <SettingsPage
      title={info.title}
      blurb="Your phone, linked once, reaches every relay host. Unlinking cuts it off at once."
      scope="All relay hosts"
      scopeIcon={<ScreenGlyph />}
    >
      <SettingsCard
        title="Reach"
        aside={reachLine(relays, devices, now)}
        status="Only hosts with the Polaris Relay on"
        action={<SettingsButton onClick={toHosts}>Open hosts</SettingsButton>}
      >
        <SettingsWell rows={false}>
          <ReachMap
            hosts={relays}
            devices={devices}
            colourOf={colourOf}
            now={now}
            onTurnOn={toHosts}
          />
        </SettingsWell>
      </SettingsCard>
      <SettingsCard
        title="Linked devices"
        aside={
          canLink && !linking ? (
            <SettingsButton variant="primary" onClick={link.start}>
              Link a device
            </SettingsButton>
          ) : undefined
        }
      >
        {devices.length === 0 ? (
          <SettingsEmpty>
            {canLink
              ? "No linked devices yet. Link your phone once; it reaches every relay host."
              : "Turn on the Polaris Relay for a host to link a device."}
          </SettingsEmpty>
        ) : (
          <SettingsWell>
            {devices.map((device) => (
              <DeviceRow
                key={device.noiseKey}
                device={device}
                now={now}
                onUnlink={() => unlink(device)}
                onRetry={() => share(device)}
              />
            ))}
          </SettingsWell>
        )}
        <LinkPanel panel={link.panel} labelOf={labelOf} onCancel={link.close} />
        <p className="pl-gap text-caption text-text-subtle flex min-h-10 items-center">
          Each one can do anything you can do here.
        </p>
      </SettingsCard>
    </SettingsPage>
  );
};

export const DevicesPage = () => {
  const hosts = useApp((s) => s.hosts);
  const { openSettings } = useShellActions();

  return <Devices hosts={hosts} onOpenHosts={() => openSettings("hosts")} />;
};
