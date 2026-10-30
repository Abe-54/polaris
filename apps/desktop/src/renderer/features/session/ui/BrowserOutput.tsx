/**
 * Output's Browser tab, after Changes (Paper "Browser (ENG-615)"): the tab with its activity
 * dot, and its body for the session's Workspace and Host.
 */
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import { type Harness, hueVar } from "@polaris/ui";
import { useApp } from "../../../shell/hooks.ts";
import { BrowserPane, useBrowserUi } from "../../browser/index.ts";
import { hasCapability, useHost } from "../hooks.ts";
import { pickBrowser } from "../output/browser.ts";
import { uiKey } from "../state.ts";
import { OutputTab } from "./SubagentOutput.tsx";

/** True while the Browser is the Output tab on screen (a Subagent's tab takes its place). */
export const useBrowserShown = (hostKey: string, sessionId: string, subagentShown: boolean) =>
  useBrowserUi(uiKey(hostKey, sessionId)).shown && !subagentShown;

export const BrowserOutputTab = ({
  hostKey,
  sessionId,
  on,
  harness,
}: {
  readonly hostKey: string;
  readonly sessionId: string;
  readonly on: boolean;
  readonly harness: Harness | null;
}) => {
  const { dot } = useBrowserUi(uiKey(hostKey, sessionId));

  return (
    <OutputTab id="browser" on={on} onClick={() => pickBrowser(hostKey, sessionId)}>
      Browser
      {dot && !on ? (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: hueVar(harness ?? "starlight") }}
          aria-label="An agent opened a tab"
          data-testid="browser-activity"
        />
      ) : null}
    </OutputTab>
  );
};

export const SessionBrowser = ({
  hostKey,
  sessionId,
  workspaceId,
  harness,
}: {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly harness: Harness | null;
}) => {
  const hostLabel = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label ?? "the host");
  const canAttach = hasCapability(useHost(hostKey), "attachments.stage");

  return (
    <BrowserPane
      hostKey={hostKey}
      workspaceId={workspaceId}
      sessionId={sessionId}
      harness={harness}
      hostLabel={hostLabel}
      canAttach={canAttach}
    />
  );
};
