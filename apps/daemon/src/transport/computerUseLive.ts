/** Computer use's services (ENG-846); `lazyComputerUse.ts` loads this on first use. */
import { Effect, Layer } from "effect";
import { AppControl, ComputerUseHost } from "../computerUse/index.ts";
import { PreviewTargets } from "../computerUse/preview/targets.ts";
import { computerUseDesktopHost, DesktopMcp } from "../harness/desktop/index.ts";
import { AgentDesktop } from "../install/agentDesktop/index.ts";
import { ComputerUseHelper } from "../service/computerUse/index.ts";

export { AppControl, ComputerUseHost, ComputerUseHostRpcHandlers } from "../computerUse/index.ts";

export { DesktopMcp } from "../harness/desktop/index.ts";

export { PreviewTargets } from "../computerUse/preview/targets.ts";

/**
 * `polaris_desktop` (agent-desktop inside the helper on macOS) follows `ComputerUseHost`'s status
 * and asks `AppControl` before each app; the preview follows what each call acted on.
 */
const desktopMcp = Layer.unwrap(
  Effect.gen(function* () {
    const targets = yield* PreviewTargets;

    return DesktopMcp.layerOn(computerUseDesktopHost, AppControl, targets.acted);
  })
);

/** Needs the Daemon's `EventStore` and `PreviewTargets`. */
export const computerUseLive = desktopMcp.pipe(
  Layer.provideMerge(AppControl.layer),
  Layer.provideMerge(ComputerUseHost.layer),
  Layer.provideMerge(Layer.mergeAll(ComputerUseHelper.layer, AgentDesktop.layer))
);
