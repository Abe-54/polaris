/** The Simulator as one of Output's tabs: choosing it, and what an agent opening one does. */
import { agentOpened, setBrowserShown } from "../../browser/index.ts";
import { setDataOutputShown } from "../../data/output/state.ts";
import { markSimulatorActivity, setSimulatorShown, simulatorUi } from "../../simulator/index.ts";
import { isTerminalShown, type TerminalPlace } from "../../terminal/index.ts";
import { showSubagent, uiKey } from "../state.ts";
import { offerOutput } from "./actions.ts";
import { isOutputHeldClosed, isOutputOpen } from "./open.ts";

/** The user picks the Simulator tab: it replaces a shown Subagent, the Browser and Data. */
export const pickSimulator = (hostKey: string, sessionId: string) => {
  const key = uiKey(hostKey, sessionId);

  showSubagent(key, null);
  setDataOutputShown(key, false);
  setBrowserShown(key, false);
  setSimulatorShown(key, true);
};

/** The user picks another Output tab. */
export const leaveSimulator = (hostKey: string, sessionId: string) =>
  setSimulatorShown(uiKey(hostKey, sessionId), false);

/**
 * An agent opened a Simulator in this session: bring it forward unless the user is in another
 * Output tab or closed Output themselves, where the tab and rail row show a dot (as the Browser).
 */
export const onAgentSimulator = (
  place: TerminalPlace,
  sessionId: string,
  subagentShown: boolean
) => {
  const key = uiKey(place.hostKey, sessionId);

  const outcome = agentOpened({
    panelOpen: isOutputOpen(key) || isTerminalShown(place.hostKey, place.workspaceId),
    browserShown: simulatorUi(key).shown && !subagentShown,
    heldClosed: isOutputHeldClosed(key),
  });

  if (outcome === "dot") markSimulatorActivity(key);

  if (outcome !== "show") return;
  offerOutput(place.hostKey, sessionId);
  pickSimulator(place.hostKey, sessionId);
};
