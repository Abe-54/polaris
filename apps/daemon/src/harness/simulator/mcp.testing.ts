/** Calls a `polaris_simulator` URL over HTTP the way an MCP client does, for tests. */
import { Schema } from "effect";

export const ToolCallResult = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
      data: Schema.optionalKey(Schema.String),
      mimeType: Schema.optionalKey(Schema.String),
    })
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});

export const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const Reply = Schema.Struct({ result: Schema.Json });

let nextId = 1;

const post = (url: string, method: string, params: typeof Schema.Json.Type) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });

/** The HTTP status of a `tools/list`. */
export const statusOf = async (url: string) => (await post(url, "tools/list", {})).status;

/** The JSON-RPC result decoded with `schema`; throws on an HTTP error. */
export const rpc = async <S extends Schema.Decoder<unknown>>(
  url: string,
  method: string,
  params: typeof Schema.Json.Type,
  schema: S
): Promise<S["Type"]> => {
  const response = await post(url, method, params);

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { result } = Schema.decodeUnknownSync(Reply)(await response.json());

  return Schema.decodeUnknownSync(schema)(result);
};

export const toolNames = async (url: string) =>
  (await rpc(url, "tools/list", {}, ToolList)).tools.map((tool) => tool.name).toSorted();

export const callTool = (url: string, name: string, args: typeof Schema.Json.Type = {}) =>
  rpc(url, "tools/call", { name, arguments: args }, ToolCallResult);

/** The first text block, or "". */
export const textOf = (result: typeof ToolCallResult.Type) => result.content[0]?.text ?? "";
