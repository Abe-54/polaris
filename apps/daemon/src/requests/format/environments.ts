/** `http-client.env.json` and `http-client.private.env.json`: environments of named values. */
import { RequestsError } from "@polaris/protocol";
import { Result, Schema } from "effect";

export const ENV_FILE = "http-client.env.json";

export const PRIVATE_ENV_FILE = "http-client.private.env.json";

/** Values every environment shares, as in JetBrains and REST Client. */
const SHARED = "$shared";

const EnvJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
);

const decode = Schema.decodeUnknownResult(EnvJson);

const isScalar = Schema.is(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));

export type Environments = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Strings, numbers and booleans; JetBrains' nested auth objects are skipped. */
const scalars = (values: (typeof EnvJson.Type)[string]) => {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(values))
    if (isScalar(value)) out[name] = String(value);

  return out;
};

/** An empty or missing file has no environments; malformed JSON is an E-INPUT error. */
export const parseEnvironments = (
  text: string,
  file: string
): Result.Result<Environments, RequestsError> => {
  if (text.trim() === "") return Result.succeed({});

  return Result.mapBoth(decode(text), {
    onFailure: () =>
      new RequestsError({
        code: "E-INPUT",
        message: `${file} is not an object of environments`,
        fix: `Write ${file} as { "dev": { "name": "value" } }`,
      }),
    onSuccess: (envs) =>
      Object.fromEntries(Object.entries(envs).map(([name, values]) => [name, scalars(values)])),
  });
};

/** Environment names across both files, `$shared` left out, in first-seen order. */
export const environmentNames = (...files: ReadonlyArray<Environments>) => [
  ...new Set(files.flatMap((envs) => Object.keys(envs)).filter((name) => name !== SHARED)),
];

/** An environment's values with `$shared` under them; undefined when it isn't in either file. */
export const environmentValues = (
  envs: Environments,
  privateEnvs: Environments,
  name: string | undefined
) => {
  if (name !== undefined && !(name in envs) && !(name in privateEnvs)) return undefined;

  const pick = (from: Environments) =>
    Object.assign({}, from[SHARED], name === undefined ? undefined : from[name]);

  return { public: pick(envs), private: pick(privateEnvs) };
};
