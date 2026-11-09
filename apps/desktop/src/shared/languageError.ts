import { LanguageError } from "@polaris/protocol";
import { Option, Schema } from "effect";
import type { IpcError } from "./api.ts";

const decodeLanguageError = Schema.decodeUnknownOption(LanguageError);

/**
 * A `LanguageError` from an instance or its plain, structured-cloned shape; null for anything
 * else. `Schema.is` would refuse the plain shape: a class schema's guard wants an instance.
 */
export const languageErrorOf = (cause: unknown): LanguageError | null =>
  Option.getOrNull(decodeLanguageError(cause));

export const languageIpcError = (error: IpcError): LanguageError =>
  languageErrorOf(error.languageError) ??
  new LanguageError({ reason: "not-ready", message: error.message, retryable: true });
