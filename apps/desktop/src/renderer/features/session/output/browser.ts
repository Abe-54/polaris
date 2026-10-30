/** The Browser as one of Output's tabs: choosing it, and what an agent's new tab does. */
import {
  agentOpened,
  browserUi,
  markBrowserActivity,
  setBrowserShown,
} from "../../browser/index.ts";
import { isTerminalShown, type TerminalPlace } from "../../terminal/index.ts";
import { showSubagent, uiKey } from "../state.ts";
import { offerOutput } from "./actions.ts";
import { isOutputHeldClosed, isOutputOpen } from "./open.ts";

/** The user picks the Browser tab: it replaces a shown Subagent. */
export const pickBrowser = (hostKey: string, sessionId: string) => {
  showSubagent(uiKey(hostKey, sessionId), null);
  setBrowserShown(uiKey(hostKey, sessionId), true);
};

/** The user picks another Output tab. */
export const leaveBrowser = (hostKey: string, sessionId: string) =>
  setBrowserShown(uiKey(hostKey, sessionId), false);

/**
 * An agent opened a tab in this session's Browser: bring it forward unless the user is in another
 * Output tab, where the Browser tab shows an activity dot.
 */
export const onAgentTab = (place: TerminalPlace, sessionId: string, subagentShown: boolean) => {
  const key = uiKey(place.hostKey, sessionId);

  const outcome = agentOpened({
    panelOpen: isOutputOpen(key) || isTerminalShown(place.hostKey, place.workspaceId),
    browserShown: browserUi(key).shown && !subagentShown,
    heldClosed: isOutputHeldClosed(key),
  });

  if (outcome === "dot") markBrowserActivity(key);

  if (outcome !== "show") return;
  offerOutput(place.hostKey, sessionId);
  pickBrowser(place.hostKey, sessionId);
};
