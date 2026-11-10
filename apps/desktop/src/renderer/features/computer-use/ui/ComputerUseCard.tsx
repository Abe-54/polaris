/**
 * The host page's Computer use card (Paper CU1, CU2): the on/off switch, a live status well,
 * the setup step for what's missing, and the apps always allowed on this Host with Remove.
 */
import type { AllowedApp } from "@polaris/protocol";
import { SettingsButton, SettingsCard, SettingsWell, Switch } from "@polaris/ui";
import { useEffect, useState } from "react";
import { type ComputerUseActions, type ComputerUseFeed } from "../hooks.ts";
import {
  allowedLine,
  allowedOn,
  type CardView,
  cardView,
  checkedAgo,
  type HostFacts,
  switchOf,
} from "../model.ts";
import { AllowStepView, AppIcon, StatusWellView } from "./parts.tsx";

/** The age of the last check, ticking each second while the card is shown. */
const useAgo = (checkedAt: string) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  return checkedAgo(checkedAt, now);
};

const AllowedRow = ({
  entry,
  busy,
  onRemove,
}: {
  readonly entry: AllowedApp;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) => (
  <div className="flex items-center gap-3 px-4 py-2.5" data-testid="computer-use-allowed-app">
    <AppIcon app={entry.app} />
    <span className="text-body text-text-default w-40 min-w-0 shrink-0 truncate">
      {entry.app.name}
    </span>
    <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
      {allowedOn(entry.allowedAt)}
    </span>
    <SettingsButton variant="quiet" disabled={busy} onClick={onRemove}>
      Remove
    </SettingsButton>
  </div>
);

const AllowedList = ({
  host,
  allowed,
  actions,
}: {
  readonly host: HostFacts;
  readonly allowed: ReadonlyArray<AllowedApp>;
  readonly actions: ComputerUseActions;
}) =>
  allowed.length === 0 ? null : (
    <>
      <div className="px-gap flex items-center justify-between gap-3 pt-1">
        <span className="text-body text-text-default">Always allowed on {host.name}</span>
        <span className="text-caption text-text-subtle truncate">
          Any agent session here can use these without asking
        </span>
      </div>
      <SettingsWell>
        {allowed.map((entry) => (
          <AllowedRow
            key={entry.app.id}
            entry={entry}
            busy={actions.busy}
            onRemove={() => actions.remove(entry.app.id)}
          />
        ))}
      </SettingsWell>
    </>
  );

/** The well for the status, then the step or the command that fixes it. */
const Body = ({
  view,
  kicker,
  actions,
}: {
  readonly view: Exclude<CardView, { readonly kind: "collapsed" }>;
  readonly kicker: string;
  readonly actions: ComputerUseActions;
}) => {
  const check = (
    <SettingsButton disabled={actions.busy} onClick={actions.checkAgain}>
      Check again
    </SettingsButton>
  );

  if (view.kind === "unavailable")
    return (
      <SettingsWell>
        <StatusWellView well={view.well} action={check} />
      </SettingsWell>
    );

  const live = view.kind === "off" ? undefined : `live · ${kicker}`;

  return (
    <>
      <SettingsWell>
        <StatusWellView well={view.well} kicker={live} />
      </SettingsWell>
      {view.kind === "mac-setup" ? (
        <SettingsWell>
          <AllowStepView
            step={view.step}
            busy={actions.busy}
            onOpen={() => actions.openSetup(view.step.permission)}
          />
        </SettingsWell>
      ) : null}
      {view.kind === "linux-setup" ? (
        <SettingsWell>
          <div className="flex items-center gap-3 px-4 py-3">
            {view.command === null ? (
              <span className="text-caption text-text-subtle flex-1">
                Polaris doesn't know this host's package manager.
              </span>
            ) : (
              <code className="text-code text-text-default min-w-0 flex-1 font-mono break-words select-text">
                {view.command}
              </code>
            )}
            {check}
          </div>
        </SettingsWell>
      ) : null}
    </>
  );
};

export interface ComputerUseCardProps {
  readonly host: HostFacts;
  readonly feed: ComputerUseFeed;
  readonly actions: ComputerUseActions;
}

/** Renders nothing until the Host's first status (and on a Daemon without computer use). */
export const ComputerUseCard = ({ host, feed, actions }: ComputerUseCardProps) => {
  const ago = useAgo(feed.status?.checkedAt ?? "");

  if (feed.status === null) return null;

  const view = cardView(host, feed.status.state, actions.opened);
  const toggle = switchOf(feed.status.state);

  if (view.kind === "collapsed")
    return (
      <section
        data-testid="computer-use-card"
        data-state="collapsed"
        className="bg-raised flex items-center gap-3 rounded-[16px] px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--color-hairline)]"
      >
        <h2 className="text-heading-sm text-text-strong shrink-0">Computer use</h2>
        <span className="text-caption text-text-subtle min-w-0 truncate">{view.line}</span>
      </section>
    );

  return (
    <SettingsCard
      data-testid="computer-use-card"
      data-state={view.kind}
      title={
        <span className="flex min-w-0 items-baseline gap-3">
          Computer use
          <span className="text-caption text-text-subtle truncate font-normal">
            Agents on {host.name} can see and use its apps, one app at a time, with your approval
          </span>
        </span>
      }
      aside={
        <Switch
          aria-label="Computer use"
          checked={toggle.on}
          disabled={toggle.disabled || actions.busy}
          onCheckedChange={actions.setOn}
        />
      }
      status={allowedLine(feed.allowed.length)}
    >
      <Body view={view} kicker={ago} actions={actions} />
      <AllowedList host={host} allowed={feed.allowed} actions={actions} />
    </SettingsCard>
  );
};
