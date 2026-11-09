/** The `.http` format, its variables and curl (ADR 0098): pure parsing plus the checkout reads they need. */
export {
  parse,
  parseDocument,
  type FileVariable,
  type ParseError,
  type RequestBlock,
  type RequestDocument,
} from "./parse.ts";

export { editRequest, serialize, serializeContent, serializeRequest } from "./serialize.ts";

export { authFromHeaders, encodedAuthorization } from "./auth.ts";

export {
  ENV_FILE,
  PRIVATE_ENV_FILE,
  environmentNames,
  environmentValues,
  parseEnvironments,
  type Environments,
} from "./environments.ts";

export {
  MASK,
  maskSecrets,
  resolveRequest,
  type Resolution,
  type VariableSources,
} from "./variables.ts";

export { formatCurl, parseCurl, shellQuote } from "./curl.ts";

export {
  REQUEST_FILE_LIMIT,
  dotenvSources,
  dotenvValues,
  fileVariables,
  isRequestFile,
  listRequestFiles,
  loadRequestFiles,
  loadSnapshot,
  variableSources,
} from "./checkout.ts";
