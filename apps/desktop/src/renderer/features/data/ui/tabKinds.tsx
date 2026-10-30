/**
 * The tab registry: each tab kind's title and body. The Table and SQL tabs plug in here from
 * their own files (TableTab.tsx, SqlTab.tsx).
 */
import type { ReactNode } from "react";
import type { DataSessionKey } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { SqlTabBody, sqlTabTitle } from "./SqlTab.tsx";
import { TableTabBody, tableTabTitle } from "./TableTab.tsx";

export const tabTitle = (tab: DataTab): string =>
  tab.kind === "table" ? tableTabTitle(tab) : sqlTabTitle(tab);

export const tabBody = (at: DataSessionKey, tab: DataTab): ReactNode =>
  tab.kind === "table" ? <TableTabBody at={at} tab={tab} /> : <SqlTabBody at={at} tab={tab} />;
