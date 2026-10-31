import { Schema } from "effect";
import { Profile, ProfileDetail, ProfileError } from "@polaris/protocol";

export const ProfileJob = Schema.Struct({
  root: Schema.String,
  checkout: Schema.String,
  active: Schema.Array(Schema.String),
  maxBytes: Schema.Number,
  maxAgeMs: Schema.Number,
  now: Schema.Number,
  operation: Schema.Literals(["list", "start", "complete", "get", "discard"]),
  id: Schema.String,
  profile: Schema.optionalKey(Profile),
});

export type ProfileJob = typeof ProfileJob.Type;

export const ProfileChanged = Schema.Struct({ changed: Schema.Literal(true) });

export const ProfileReply = Schema.Union([
  Schema.Struct({ profiles: Schema.Array(Profile) }),
  ProfileDetail,
  Schema.Struct({ profile: Profile }),
  Schema.Struct({
    error: Schema.Struct({
      code: ProfileError.fields.code,
      message: Schema.String,
      fix: Schema.String,
    }),
  }),
]);

export type ProfileReply = typeof ProfileReply.Type;
