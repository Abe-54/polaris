/**
 * The Browser in Output (ENG-615): each Agent Session's tabs, shown in main's WebContentsViews
 * over the Browser area. The session feature places the tab; this feature draws its body.
 */
export { BrowserPane, type BrowserPaneProps } from "./BrowserPane.tsx";

export { browserKey, useBrowserFeed } from "./feed.ts";

export { agentOpened, type OutputPlace } from "./model.ts";

export { BrowserForget } from "./forget.tsx";

export { BrowserWorking } from "./working.tsx";

export { browserUi, markBrowserActivity, setBrowserShown, useBrowserUi } from "./state.ts";
