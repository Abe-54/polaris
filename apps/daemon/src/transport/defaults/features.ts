import {
  BrowserStackRpcs,
  ComputerUseRpcs,
  DataRpcs,
  DeveloperModeRpcs,
  LanguageRpcs,
  PredictionError,
  PredictionRpcs,
  ProfilesRpcs,
  SelfTraceRpcs,
  SimulatorRpcs,
  TraceCompareRpcs,
  TracingSkillRpcs,
  TracesRpcs,
  TracesSettingsRpcs,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { browserDefaults } from "../../browser/index.ts";
import { languageDefaults } from "../languageDefaults.ts";
import { unsupported, unsupportedFeed } from "./shared.ts";

const prediction = (message: string) => () =>
  Effect.fail(new PredictionError({ reason: "unavailable", message }));

const predictionFeed = (message: string) => () =>
  Stream.fail(new PredictionError({ reason: "unavailable", message }));

const predictionDefaults = PredictionRpcs.toLayer({
  "prediction.capability": prediction("Prediction capability is unavailable"),
  "prediction.context": prediction("Prediction context is unavailable"),
  "prediction.complete": predictionFeed("Prediction completion is unavailable"),
  "prediction.edit": predictionFeed("Edit prediction is unavailable"),
  "prediction.server": prediction("Model server checks are unavailable"),
  "prediction.managed": prediction("Managed model server is unavailable"),
  "prediction.managed.watch": predictionFeed("Managed model server is unavailable"),
});

const dataDefaults = DataRpcs.toLayer({
  "data.sources.watch": unsupportedFeed("data"),
  "data.queryLog.watch": unsupportedFeed("data"),
  "data.schemaDiff": unsupported("data.schemaDiff"),
  "data.describe": unsupported("data"),
  "data.query": unsupported("data"),
  "data.query.stream": unsupportedFeed("data"),
  "data.queryLog.page": unsupported("data"),
  "data.source.save": unsupported("data"),
  // Until ENG-708's SQ (SQLite) lands.
  "data.source.saveFile": unsupported("data.sqlite"),
  "data.source.remove": unsupported("data"),
  "data.source.label": unsupported("data"),
  "data.edits.commit": unsupported("data"),
  "data.source.access": unsupported("data"),
});

const traceDefaults = Layer.mergeAll(
  TracesRpcs.toLayer({
    "traces.watch": unsupportedFeed("traces"),
    "traces.get": unsupported("traces"),
    "traces.span": unsupported("traces"),
  }),
  TracesSettingsRpcs.toLayer({
    "traces.settings": unsupported("traces.settings"),
    "traces.setSettings": unsupported("traces.settings"),
  }),
  ProfilesRpcs.toLayer({
    "profiles.watch": unsupportedFeed("traces.profiles"),
    "profiles.attach": unsupported("traces.profiles.attach"),
    "profiles.get": unsupported("traces.profiles"),
    "profiles.restartWithProfiling": unsupported("traces.profiles"),
  }),
  TraceCompareRpcs.toLayer({ "traces.compare": unsupported("traces.compare") }),
  TracingSkillRpcs.toLayer({ "traces.installSkill": unsupported("traces.skill") }),
  // Until ENG-708's DT (Self-Traces) lands.
  SelfTraceRpcs.toLayer({ "traces.ingestSelf": unsupported("traces.self") })
);

// Until ENG-708's S (Developer Mode) lands.
const developerModeDefaults = DeveloperModeRpcs.toLayer({
  "developerMode.get": unsupported("developer-mode"),
  "developerMode.set": unsupported("developer-mode"),
  "developerMode.setWorkspace": unsupported("developer-mode"),
  "developerMode.lease": unsupportedFeed("developer-mode"),
  "developerMode.watch": unsupportedFeed("developer-mode"),
});

/** Unsupported until `serve.ts` layers `SimulatorRpcHandlers` over it. */
const simulatorDefaults = SimulatorRpcs.toLayer({
  "simulator.watch": unsupportedFeed("simulator"),
  "simulator.boot": unsupported("simulator"),
  "simulator.shutdown": unsupported("simulator"),
  "simulator.restart": unsupported("simulator"),
  "simulator.attach": unsupportedFeed("simulator"),
  "simulator.sessionFeed": unsupportedFeed("simulator"),
});

/**
 * Computer use (ENG-846) where no real handler serves it: `Unsupported`. `serve.ts` layers the
 * status, setup, on/off, allowed list and preview handlers over it.
 */
const computerUseDefaults = ComputerUseRpcs.toLayer({
  "computerUse.status": unsupported("computer-use"),
  "computerUse.watch": unsupportedFeed("computer-use"),
  "computerUse.enable": unsupported("computer-use"),
  "computerUse.disable": unsupported("computer-use"),
  "computerUse.openSetup": unsupported("computer-use"),
  "computerUse.allowedApps": unsupported("computer-use"),
  "computerUse.removeAllowedApp": unsupported("computer-use"),
  "computerUse.allowedApps.add": unsupported("computer-use"),
  "computerUse.app": unsupported("computer-use"),
  "computerUse.preview.watch": unsupportedFeed("computer-use.preview"),
  "computerUse.preview.latest": unsupported("computer-use"),
});

/** Languages, Prediction, the browser, Data, Traces, Developer Mode, the Simulator, computer use. */
export const featureDefaults = Layer.mergeAll(
  LanguageRpcs.toLayer(languageDefaults),
  predictionDefaults,
  BrowserStackRpcs.toLayer(browserDefaults),
  dataDefaults,
  traceDefaults,
  developerModeDefaults,
  simulatorDefaults,
  computerUseDefaults
);
