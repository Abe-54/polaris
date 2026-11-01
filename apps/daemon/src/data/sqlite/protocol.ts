/** Replies from the `polaris data-sqlite` child to the Daemon. */
import { Schema } from "effect";

export const ChildFailure = Schema.Struct({
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
});

export type ChildFailure = typeof ChildFailure.Type;
