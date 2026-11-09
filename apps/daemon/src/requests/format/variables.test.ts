import { expect, test } from "bun:test";
import type { AdHocRequest } from "@polaris/protocol";
import { Result } from "effect";
import {
  MASK,
  environmentNames,
  environmentValues,
  maskSecrets,
  parseEnvironments,
  resolveRequest,
  type VariableSources,
} from "./index.ts";

const sources = (overrides: Partial<VariableSources> = {}): VariableSources => ({
  file: {},
  public: {},
  private: {},
  dotenv: {},
  now: () => new Date("2026-11-09T12:00:00.000Z"),
  ...overrides,
});

const get = (url: string, extra: Partial<AdHocRequest> = {}): AdHocRequest => ({
  method: "GET",
  url,
  headers: [],
  ...extra,
});

const resolved = (request: AdHocRequest, from: VariableSources) => {
  const result = resolveRequest(request, from, "dev");

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

test("an undefined variable is an error naming every missing one, never an empty string", () => {
  const result = resolveRequest(
    get("{{base}}/x?k={{key}}&t={{$dotenv TOKEN}}&w={{$weird}}"),
    sources(),
    "dev"
  );

  expect(Result.isFailure(result) && [result.failure.code, result.failure.message]).toEqual([
    "E-VARIABLE-UNRESOLVED",
    "Not defined: {{base}}, {{key}}, {{$dotenv TOKEN}}, {{$weird}}",
  ]);
});

test("a variable that refers to itself is an error", () => {
  const result = resolveRequest(get("{{a}}"), sources({ file: { a: "{{b}}", b: "{{a}}" } }));

  expect(Result.isFailure(result) && result.failure.code).toBe("E-VARIABLE-UNRESOLVED");
});

test("file @vars win over the environment, and nest", () => {
  const out = resolved(
    get("{{api}}/users"),
    sources({
      file: { api: "{{base}}/v2", base: "http://file.test" },
      public: { base: "http://env.test" },
    })
  );

  expect(out.request.url).toBe("http://file.test/v2/users");
});

test("a value built from a secret is masked too, and its secret is listed for masking", () => {
  const out = resolved(
    get("https://api.test/", { headers: [{ name: "Authorization", value: "{{auth}}" }] }),
    sources({ file: { auth: "Bearer {{$dotenv TOKEN}}" }, dotenv: { TOKEN: "t0k" } })
  );

  expect(out.request.headers[0]?.value).toBe("Bearer t0k");
  expect(out.variables).toEqual([
    { name: "auth", source: "file", masked: true },
    { name: "$dotenv TOKEN", source: "dotenv", masked: true },
  ]);
  expect(maskSecrets("Authorization: Bearer t0k", out.secrets)).toBe(`Authorization: ${MASK}`);
});

test("dynamic values resolve without being listed as variables", () => {
  const out = resolved(
    get("https://api.test/", {
      body: '{"at":"{{$isoTimestamp}}","ts":{{$timestamp}},"id":"{{$random.uuid}}"}',
    }),
    sources()
  );

  expect(out.request.body).toMatch(
    /^\{"at":"2026-11-09T12:00:00.000Z","ts":1794225600,"id":"[0-9a-f-]{36}"\}$/
  );
  expect(out.variables).toEqual([]);
});

test("environments: $shared sits under each one, private values are kept apart, bad JSON is E-INPUT", () => {
  const envs = parseEnvironments(
    '{"$shared":{"v":1,"base":"s"},"dev":{"base":"d","auth":{"type":"x"}}}',
    "e.json"
  );

  const priv = parseEnvironments('{"dev":{"key":"k"},"prod":{}}', "p.json");

  if (Result.isFailure(envs) || Result.isFailure(priv)) throw new Error("did not parse");
  expect(environmentNames(envs.success, priv.success)).toEqual(["dev", "prod"]);
  expect(environmentValues(envs.success, priv.success, "dev")).toEqual({
    public: { v: "1", base: "d" },
    private: { key: "k" },
  });
  expect(environmentValues(envs.success, priv.success, "qa")).toBeUndefined();

  const bad = parseEnvironments("[1, 2]", "e.json");
  expect(Result.isFailure(bad) && bad.failure.code).toBe("E-INPUT");
});
