/**
 * A link in assistant prose to a Host address (`browserLinkOf`): it opens a tab in the session's
 * Browser and brings the Browser forward. Without a session (a preview) it stays a plain link.
 */
import { PixelFailedIcon, showToast } from "@polaris/ui";
import type { MouseEvent, ReactNode } from "react";
import { openBrowserLink } from "../../../browser/index.ts";
import { useEditorPlace } from "../../../editor-links/index.ts";
import { offerOutput } from "../../output/actions.ts";
import { pickBrowser } from "../../output/browser.ts";

const LINK =
  "text-text-strong decoration-text-faint hover:decoration-text-subtle underline underline-offset-2";

export interface BrowserLinkProps {
  readonly url: string;
  readonly children: ReactNode;
}

export const BrowserLink = ({ url, children }: BrowserLinkProps) => {
  const place = useEditorPlace();
  const sessionId = place?.sessionId ?? null;
  const workspaceId = place?.workspaceId ?? null;

  if (place === null || sessionId === null || workspaceId === null)
    return (
      <a href={url} target="_blank" rel="noreferrer" className={LINK}>
        {children}
      </a>
    );

  const { hostKey } = place;

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    void openBrowserLink({ hostKey, workspaceId, sessionId }, url, () => {
      offerOutput(hostKey, sessionId);
      pickBrowser(hostKey, sessionId);
    }).then((opened) => {
      if (!opened)
        showToast({
          source: "starlight",
          icon: <PixelFailedIcon size={16} />,
          title: "Couldn't open the link in the browser",
          message: url,
        });
    });
  };

  return (
    <a href={url} onClick={onClick} title={url} data-testid="browser-link" className={LINK}>
      {children}
    </a>
  );
};
