import { join } from "node:path";
import { polarisHome } from "../paths.ts";
import { Layer } from "effect";
import { TraceRuntime, TRACE_PORT } from "./runtimeService.ts";
import { TraceSessions } from "./sessionsService.ts";
import { TraceStore } from "./storeService.ts";
import { TraceSettings } from "./settings.ts";
import { InspectorTargets } from "./attach/registry.ts";

/** The receiver owns its fixed port before this implementation graph is needed. */
export const traceServicesAt = (port = TRACE_PORT) =>
  TraceRuntime.layerAt(join(polarisHome(), "trace-tokens.json"), port).pipe(
    Layer.provideMerge(TraceSettings.layer),
    Layer.provideMerge(InspectorTargets.layer),
    Layer.provideMerge(TraceSessions.layer),
    Layer.provideMerge(TraceStore.layer)
  );
