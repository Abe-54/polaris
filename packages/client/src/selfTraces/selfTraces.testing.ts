/** A Self-Trace Span for tests, numbered and optionally padded to a size. */
import type { SelfSpan } from "@polaris/protocol";

export const testSpan = (n: number, padding = 0): SelfSpan => ({
  traceId: "a".repeat(32),
  id: n.toString(16).padStart(16, "0"),
  parentId: null,
  name: `span ${n}`,
  kind: "internal",
  status: "unset",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: padding === 0 ? {} : { pad: "x".repeat(padding) },
  resource: {},
  scope: { name: "test", version: "0", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
});
