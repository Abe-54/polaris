/** The service map's model (DESIGN.md, Traces → Service map): pure, over one trace's TraceTimes. */
export {
  type Caller,
  commandOf,
  type MapEdge,
  type MapNode,
  type NodeKind,
  type ServiceMap,
  serviceMap,
} from "./graph.ts";

export { inferTarget, matchService, protocolOf, type Target } from "./infer.ts";

export {
  LABEL_ABOVE,
  type MapLayout,
  mapLayout,
  PITCH,
  type PlacedNode,
  type Point,
  type Route,
  SLOT,
} from "./layout.ts";

export {
  isNPlusOne,
  N_PLUS_ONE_AT,
  nPlusOneLine,
  type PanelCall,
  type PanelCaller,
  type ServicePanelModel,
  servicePanel,
} from "./panel.ts";

export { callerWords, edgeWords, nodeWords, turnWords } from "./words.ts";

export {
  fitView,
  MARGIN,
  MAX_ZOOM,
  MIN_ZOOM,
  OPEN_ZOOM,
  openView,
  type Size,
  transformOf,
  type Viewport,
  wheelFactor,
  zoomAt,
} from "./viewport.ts";
