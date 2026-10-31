/** Explicit retry keys outlive their Turn; the argument hash prevents reuse for a different write. */
import type { ExecuteDataInput, DataValue } from "@polaris/protocol";

type Input = typeof ExecuteDataInput.Type;

type IdentityParts = ReadonlyArray<string | ReadonlyArray<DataValue>>;

const hash = (value: IdentityParts) =>
  Bun.CryptoHasher.hash("sha256", JSON.stringify(value), "hex");

export const writeRequestKey = (input: Input) =>
  input.requestId === undefined
    ? undefined
    : hash(["execute-request", input.sessionId, input.requestId]);

export const writeRequestHash = (input: Input) =>
  hash([input.source, input.sql, input.params ?? [], input.reason]);
