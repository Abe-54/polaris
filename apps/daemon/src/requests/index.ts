/** Requests (ADR 0098): the `.http` format and the send engine with its Send Log. */
export {
  RequestSends,
  type PendingSend,
  type PreSendHook,
  type PreSendVerdict,
  type RequestSendsOptions,
  type SendInput,
} from "./sendsService.ts";

export { SEND_LOG_LIMIT, type PageOptions } from "./sendLog.ts";

export { SEND_TIMEOUT_MS } from "./transmit.ts";

export { SEND_SERVICE, SEND_SPAN_NAME } from "./rootSpan.ts";
