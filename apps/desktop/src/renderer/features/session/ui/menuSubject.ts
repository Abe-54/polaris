/**
 * What a right-click in the transcript landed on, read from the row's markup: a link or
 * image, a file a tool touched (`data-menu-path`, `data-menu-line`, `data-menu-diff` on a
 * change with a diff), or a command by its item id (`data-menu-command`).
 */
import { externalUrl } from "../../../../shared/externalUrl.ts";

const MENU_PATH = "data-menu-path";

const MENU_LINE = "data-menu-line";

const MENU_DIFF = "data-menu-diff";

const MENU_COMMAND = "data-menu-command";

export interface Subject {
  readonly link: string | null;
  readonly image: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly diff: boolean;
  readonly command: string | null;
}

const lineOf = (text: string | null) => {
  const n = text === null ? Number.NaN : Number.parseInt(text, 10);

  return Number.isFinite(n) && n > 0 ? n : null;
};

export const subjectAt = (target: Element): Subject => {
  const anchor = target.closest("a[href]");
  const image = target.closest("img[src]");
  const file = target.closest(`[${MENU_PATH}]`);
  const command = target.closest(`[${MENU_COMMAND}]`);
  const link = externalUrl(anchor?.getAttribute("href") ?? "");

  return {
    link: link ?? externalUrl(image?.getAttribute("src") ?? ""),
    image: link === null && image !== null,
    path: file?.getAttribute(MENU_PATH) ?? null,
    line: lineOf(file?.getAttribute(MENU_LINE) ?? null),
    diff: file?.hasAttribute(MENU_DIFF) === true,
    command: command?.getAttribute(MENU_COMMAND) ?? null,
  };
};
