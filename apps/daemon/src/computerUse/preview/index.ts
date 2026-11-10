/**
 * The computer use preview (ENG-846): what a watching Client sees of the window an Agent
 * Session works in. See the README beside this file.
 */
import { Layer } from "effect";
import { ComputerUseHelper } from "../../service/computerUse/index.ts";
import { captureLayer } from "./capture.ts";
import { livePreview } from "./group.ts";
import { PreviewHandlersLive } from "./rpcs.ts";
import { stillLayer } from "./still.ts";

export { PREVIEW_CAPABILITY, PreviewRpcs, livePreview } from "./group.ts";

export { type PreviewEvent, type PreviewImage, PreviewSource } from "./source.ts";

export { type PreviewAction, type PreviewTarget, PreviewTargets } from "./targets.ts";

/** The live capture where this Host has it, else the last action's screenshot. */
const source = Layer.suspend(() =>
  livePreview() ? captureLayer().pipe(Layer.provide(ComputerUseHelper.layer)) : stillLayer
);

/** The preview RPCs for this Host. Needs the Daemon's `PreviewTargets` and its event store. */
export const PreviewRpcsLive = PreviewHandlersLive.pipe(Layer.provide(source));
