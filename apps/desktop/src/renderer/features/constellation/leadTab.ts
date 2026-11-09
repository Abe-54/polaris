/** Which tab a Lead's Output shows, set from outside its view (a notification click). */
import { setDataOutputShown } from "../data/output/state.ts";
import { leaveBrowser } from "../session/output/browser.ts";
import { showSubagent, uiKey } from "../session/state.ts";
import { leadKey, patchLeadUi } from "./state.ts";

/** Puts a Lead's Output on `tab`, closing a subagent, the browser or Data shown over it. */
export const showLeadTab = (
  hostKey: string,
  sessionId: string,
  tab: "constellation" | "changes"
) => {
  showSubagent(uiKey(hostKey, sessionId), null);
  leaveBrowser(hostKey, sessionId);
  setDataOutputShown(uiKey(hostKey, sessionId), false);
  patchLeadUi(leadKey(hostKey, sessionId), () => ({ tab }));
};
