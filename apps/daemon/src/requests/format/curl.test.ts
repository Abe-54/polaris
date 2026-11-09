import { expect, test } from "bun:test";
import { RequestAuth, type AdHocRequest } from "@polaris/protocol";
import { Result } from "effect";
import { MASK, formatCurl, parseCurl } from "./index.ts";

const parsed = (text: string) => {
  const result = parseCurl(text);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

test("a multi-line curl with quoting, -X, -H, --data-raw and -u parses", () => {
  const text = `curl -X PATCH 'https://api.test/invoices/inv_1?x=1' \\
  -H 'Content-Type: application/json' \\
  -H "X-Note: it's \\"quoted\\"" \\
  --data-raw '{"status":"paid","note":"it'\\''s"}' \\
  -u ops:hunter2 --compressed -sSL`;

  expect(parsed(text)).toEqual({
    method: "PATCH",
    url: "https://api.test/invoices/inv_1?x=1",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "X-Note", value: 'it\'s "quoted"' },
    ],
    body: '{"status":"paid","note":"it\'s"}',
    auth: RequestAuth.cases.Basic.make({ user: "ops", password: "hunter2" }),
  });
});

test("data means POST, --json adds JSON headers, a Bearer header becomes auth, $'…' unescapes", () => {
  expect(parsed(`curl https://api.test/a -d a=1 --data b=2`)).toMatchObject({
    method: "POST",
    body: "a=1&b=2",
  });
  expect(
    parsed(`curl --json '{"a":1}' --url=https://api.test/j -H 'Authorization: Bearer abc'`)
  ).toEqual({
    method: "POST",
    url: "https://api.test/j",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Accept", value: "application/json" },
    ],
    body: '{"a":1}',
    auth: RequestAuth.cases.Bearer.make({ token: "abc" }),
  });
  expect(parsed(`curl -XDELETE $'https://api.test/\\x' -b 'a=1'`)).toEqual({
    method: "DELETE",
    url: "https://api.test/\\x",
    headers: [{ name: "Cookie", value: "a=1" }],
  });
});

test.each([
  ["wget https://x.test", "This isn't a curl command"],
  ["curl 'https://x.test", "A quote is never closed"],
  ["curl -H 'Accept: x'", "The command has no URL"],
  ["curl -X TRACE https://x.test", "Unsupported method TRACE"],
  ["curl --upload-file f https://x.test", "Unsupported curl option --upload-file"],
  ["curl -d @body.json https://x.test", "Bodies read from files (@file) aren't supported"],
])("%s is an E-CURL-PARSE error", (text, message) => {
  const result = parseCurl(text);

  expect(Result.isFailure(result) && [result.failure.code, result.failure.message]).toEqual([
    "E-CURL-PARSE",
    message,
  ]);
});

test("formatting masks secrets and parses back to the same request", () => {
  const request: AdHocRequest = {
    method: "POST",
    url: "https://api.test/login?next=/home",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: `{"user":"o'brien","key":"sk_live_1"}`,
    auth: RequestAuth.cases.Bearer.make({ token: "sk_live_1" }),
  };

  expect(parsed(formatCurl(request))).toEqual(request);
  expect(formatCurl(request, ["sk_live_1"])).toBe(
    [
      "curl -X POST 'https://api.test/login?next=/home'",
      "-H 'Content-Type: application/json'",
      `-H 'Authorization: Bearer ${MASK}'`,
      `--data-raw '{"user":"o'\\''brien","key":"${MASK}"}'`,
    ].join(" \\\n  ")
  );
});
