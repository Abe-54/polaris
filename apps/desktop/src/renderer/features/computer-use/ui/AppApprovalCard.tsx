/** A computer use approval in the transcript (Paper CU4): the app, why, and the answers. */
import { AppId, type ApprovalRequest, DesktopApp } from "@polaris/protocol";
import { SettingsButton } from "@polaris/ui";
import { appApprovalView, appNameOf } from "../approval.ts";
import { AppIcon } from "./parts.tsx";

const Pointer = () => (
  <span
    aria-hidden
    className="bg-fill-selected flex size-10 shrink-0 items-center justify-center rounded-[9px]"
  >
    <svg width="20" height="20" viewBox="0 0 20 20">
      <path d="M5 3v12l3-3 2 5 2-1-2-5h4z" className="fill-text-default" />
    </svg>
  </span>
);

export interface AppApprovalCardProps {
  readonly request: ApprovalRequest;
  /** The Harness's name, or "The agent". */
  readonly who: string;
  readonly host: string;
  readonly onAllow: () => void;
  readonly onAlwaysAllow: () => void;
  readonly onDeny: () => void;
}

export const AppApprovalCard = ({
  request,
  who,
  host,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: AppApprovalCardProps) => {
  const view = appApprovalView(request, who, host);

  // A request without an app still shows an icon: the monogram of "an app".
  const app =
    request.app ??
    new DesktopApp({ id: AppId.make(request.id), name: appNameOf(request), icon: null });

  return (
    <div
      data-testid="app-approval"
      data-kind={request.kind}
      className="bg-raised border-hairline flex flex-col gap-3 rounded-[14px] border p-3.5"
    >
      <div className="bg-well border-hairline flex flex-col gap-2 rounded-[10px] border p-3">
        <div className="flex items-center gap-3">
          {request.kind === "headed-input" ? <Pointer /> : <AppIcon app={app} size={40} />}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-heading-sm text-text-strong">{view.headline}</p>
            {view.reason === null ? null : (
              <p className="text-caption text-text-subtle">{view.reason}</p>
            )}
          </div>
        </div>
        {view.takeOver === null ? null : (
          <p className="text-caption text-text-subtle border-hairline border-t pt-2">
            {view.takeOver}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <SettingsButton variant="primary" onClick={onAllow}>
          Allow once
        </SettingsButton>
        {view.always === null ? null : (
          <SettingsButton onClick={onAlwaysAllow}>{view.always}</SettingsButton>
        )}
        <SettingsButton variant="quiet" onClick={onDeny}>
          Deny
        </SettingsButton>
      </div>
      <p className="text-caption text-text-faint">{view.footnote}</p>
    </div>
  );
};
