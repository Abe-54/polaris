/**
 * A pull request's right-click menu in Review, on its queue row and its header: Open in
 * GitHub, Copy link. An Agent Session has no page on GitHub, so its rows get none.
 */
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuEntries,
  ContextMenuTrigger,
  type MenuAction,
} from "@polaris/ui";
import { type ReactElement, useEffect } from "react";
import { hostOf, type PullRef } from "../../../../shared/github.ts";
import { useCommands } from "../../../shell/hooks.ts";
import { copyEntry, copyWithToast } from "../../../shell/menu/index.ts";
import { polaris } from "../../bridge.ts";

export const openInGitHub = (url: string) => void polaris().request("shell.openExternal", { url });

/** Its page on its GitHub host, for when GitHub hasn't sent the detail's `url` yet. */
export const pullUrlOf = (pull: PullRef) =>
  `https://${hostOf(pull.repo)}/${pull.repo.owner}/${pull.repo.name}/pull/${pull.number}`;

/** The palette's "Open #88 in GitHub" and "Copy link to #88" while a pull request is open. */
export const usePullCommands = (number: number, url: string) => {
  const registry = useCommands();

  useEffect(() => {
    return registry.contribute([
      {
        id: "review.openInGitHub",
        title: `Open #${number} in GitHub`,
        palette: { group: "workspace", keywords: ["pull request", "browser", "web", "github"] },
        handler: { run: () => openInGitHub(url) },
      },
      {
        id: "review.copyPullLink",
        title: `Copy link to #${number}`,
        palette: { group: "workspace", keywords: ["pull request", "url", "github"] },
        handler: { run: () => copyWithToast(url, "link") },
      },
    ]);
  }, [registry, number, url]);
};

export const pullMenuEntries = (url: string): ReadonlyArray<MenuAction> => [
  {
    kind: "item",
    label: "Open in GitHub",
    onSelect: () => openInGitHub(url),
    testId: "pull-menu-open",
  },
  copyEntry("Copy link", url, "pull-menu-copy"),
];

export interface PullMenuProps {
  /** The pull request's page on GitHub. */
  readonly url: string;
  readonly children: ReactElement;
}

export const PullMenu = ({ url, children }: PullMenuProps) => (
  <ContextMenu>
    <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent data-testid="pull-menu">
      <ContextMenuEntries entries={pullMenuEntries(url)} />
    </ContextMenuContent>
  </ContextMenu>
);
