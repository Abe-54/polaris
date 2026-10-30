/**
 * Restart daemon's states in the Daemon card (Paper HS-D4): Confirm in place with what would
 * be interrupted, Back with the pixel check, and Failed as a reason card with the command and
 * its output. Restarting itself is drawn in the Vitals card.
 */
import { Celestial, PixelCheckIcon, SettingsButton, SettingsWell } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { RestartPreviewView } from "../../../../shared/restart.ts";
import { call } from "../hooks.tsx";
import { elapsed } from "../model.ts";
import { harnessBody } from "../page/parts.tsx";
import {
  backCaption,
  confirmBody,
  type Failed,
  failedBody,
  failedTitle,
  failedWell,
  moreSessions,
  WELL_SESSIONS,
} from "./model.ts";
import type { RestartState } from "./useRestart.ts";

const KICKER = "text-text-subtle font-mono text-[10px] leading-3 tracking-[0.06em] uppercase";

export interface ConfirmPanelProps {
  readonly label: string;
  readonly preview: RestartPreviewView;
  /** "LAUNCHCTL KICKSTART -K · OVER SSH". */
  readonly command: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export const ConfirmPanel = ({
  label,
  preview,
  command,
  onCancel,
  onConfirm,
}: ConfirmPanelProps) => {
  const sessions = preview.interrupts?.workingSessions ?? [];
  const more = moreSessions(preview.interrupts);

  return (
    <SettingsWell rows={false} data-testid="restart-confirm">
      <div
        role="alertdialog"
        aria-label={`Restart the daemon on ${label}?`}
        className="flex flex-col gap-3 px-4 pt-3.5 pb-3"
      >
        <div className="flex flex-col gap-1">
          <span className="text-body text-text-strong font-medium">
            Restart the daemon on {label}?
          </span>
          <p className="text-body text-text-default" data-testid="restart-consequence">
            {confirmBody(preview.interrupts)}
          </p>
        </div>
        {sessions.length === 0 ? null : (
          <ul className="bg-surface-sunken divide-hairline flex flex-col divide-y rounded-[8px]">
            {sessions.slice(0, WELL_SESSIONS).map((s) => (
              <li key={s.sessionId} className="flex h-[34px] items-center gap-2.5 px-3">
                <Celestial body={harnessBody(s.harness)} harness={s.harness} size={16} />
                <span className="text-body text-text-default min-w-0 flex-1 truncate">
                  {s.title}
                </span>
                <span className="text-caption text-text-subtle shrink-0">
                  Working · turn {s.turn}
                </span>
              </li>
            ))}
            {more === null ? null : (
              <li className="text-caption text-text-subtle flex h-[30px] items-center px-3">
                {more}
              </li>
            )}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <span className={`${KICKER} min-w-0 flex-1 truncate`}>{command}</span>
          <SettingsButton variant="ghost" autoFocus onClick={onCancel}>
            Cancel
          </SettingsButton>
          <SettingsButton variant="danger" onClick={onConfirm}>
            Restart daemon
          </SettingsButton>
        </div>
      </div>
    </SettingsWell>
  );
};

type BackState = Extract<RestartState, { readonly step: "back" }>;

/** Seconds since it came back, ticking while shown. */
const useSince = (at: number) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  return Math.max(0, now - at);
};

export const BackPanel = ({
  state,
  onShowSessions,
}: {
  readonly state: BackState;
  readonly onShowSessions: () => void;
}) => {
  const since = useSince(state.at);

  return (
    <SettingsWell rows={false} data-testid="restart-back">
      <div className="flex items-center gap-3 px-4 py-3">
        <PixelCheckIcon size={12} aria-hidden className="text-text-default shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-body text-text-default tabular">
            Daemon restarted · {elapsed(since)} ago
          </span>
          <span className="text-caption text-text-subtle truncate">
            {backCaption(state.result)}
          </span>
        </div>
        <SettingsButton onClick={onShowSessions}>Show sessions</SettingsButton>
      </div>
    </SettingsWell>
  );
};

const CopyCommand = ({ text }: { readonly text: string }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <SettingsButton
      variant="quiet"
      onClick={() =>
        void call("clipboard.write", { text }).then((done) => setCopied(done !== null))
      }
    >
      {copied ? "Copied" : "Copy command"}
    </SettingsButton>
  );
};

export const FailedPanel = ({
  label,
  result,
  onReinstall,
}: {
  readonly label: string;
  readonly result: Failed;
  readonly onReinstall: () => void;
}) => (
  <SettingsWell rows={false} data-testid="restart-failed">
    <div className="flex flex-col gap-3 px-4 pt-3.5 pb-3">
      <div className="flex flex-col gap-1">
        <span className="text-body text-text-strong font-medium">{failedTitle(label)}</span>
        <p className="text-body text-text-default">{failedBody(result, label)}</p>
      </div>
      <pre className="bg-surface-sunken text-text-default overflow-x-auto rounded-[8px] px-3 py-2.5 font-mono text-[11px] leading-[17px] whitespace-pre-wrap">
        {failedWell(result)}
      </pre>
      <div className="flex items-center justify-end gap-2">
        {result.command === null ? null : <CopyCommand text={result.command} />}
        {result.reinstall ? (
          <SettingsButton onClick={onReinstall}>Reinstall service</SettingsButton>
        ) : null}
      </div>
    </div>
  </SettingsWell>
);
