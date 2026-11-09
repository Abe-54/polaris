/**
 * Requests (⌘6; DESIGN.md, Requests; ADR 0098): the layout and its slots, the hooks over the
 * Requests IPC contract, and the open Request's state. The interface for the shell and other features.
 */
export { RequestsMode } from "./ui/LazyRequestsMode.tsx";

export { requestsUnavailable, useRequestsUnavailable } from "./model/availability.ts";

export type { RequestsSessionKey } from "./model/session.ts";

export { RequestsLayer, useRequestsApi, useRequestsSnapshot } from "./data/hooks.tsx";

export { liveRequestsApi, type RequestsApi } from "./data/api.ts";

export { openNewDraft, openRequest, requestsView, useRequestsView } from "./model/store.ts";

export type { RequestsSlotProps, SendPaneProps } from "./ui/slots.ts";
