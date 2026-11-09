/** curl both ways: a pasted command to an ad-hoc Request, and a Request to a command with secrets masked. */
import {
  HttpMethod,
  RequestAuth,
  RequestsError,
  type AdHocRequest,
  type HttpHeader,
} from "@polaris/protocol";
import { Match, Result, Schema } from "effect";
import { authFromHeaders } from "./auth.ts";
import { shellWords } from "./shellWords.ts";
import { maskSecrets } from "./variables.ts";

const isMethod = Schema.is(HttpMethod);

const DATA = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
]);

/** Options that change nothing Polaris sends, with and without a value. */
const IGNORED_FLAGS = new Set([
  "--compressed",
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-L",
  "--location",
  "-k",
  "--insecure",
  "-i",
  "--include",
  "-v",
  "--verbose",
  "-f",
  "--fail",
  "-g",
  "--globoff",
  "--http1.1",
  "--http2",
]);

const IGNORED_VALUES = new Set(["-o", "--output", "-m", "--max-time", "--connect-timeout"]);

/** Options whose value is a header. */
const HEADER_VALUES = new Map([
  ["-A", "User-Agent"],
  ["--user-agent", "User-Agent"],
  ["-b", "Cookie"],
  ["--cookie", "Cookie"],
  ["-e", "Referer"],
  ["--referer", "Referer"],
]);

interface Draft {
  method?: string;
  url?: string;
  headers: HttpHeader[];
  data: string[];
  json: boolean;
  user?: string;
}

const curlError = (message: string, fix = "Paste the command as copied, starting with curl") =>
  new RequestsError({ code: "E-CURL-PARSE", message, fix });

/** `--name=value` and `-Xvalue` split into the option and its value. */
const splitOption = (word: string): [string, string | undefined] => {
  const long = /^(--[^=]+)=(.*)$/s.exec(word);

  if (long) return [long[1]!, long[2]];

  if (/^-[A-Za-z]./s.test(word) && !IGNORED_FLAGS.has(word))
    return [word.slice(0, 2), word.slice(2)];

  return [word, undefined];
};

const header = (value: string): HttpHeader | undefined => {
  const match = /^([^:]+):\s*(.*)$/s.exec(value);

  return match?.[1] ? { name: match[1].trim(), value: match[2] ?? "" } : undefined;
};

/** Applies one option with its value to the draft; a string is an error message. */
const applyValue = (draft: Draft, option: string, value: string): string | undefined => {
  if (option === "-X" || option === "--request") draft.method = value.toUpperCase();
  else if (option === "-H" || option === "--header") {
    const parsed = header(value);

    if (!parsed) return `Not a header: ${value}`;
    draft.headers.push(parsed);
  } else if (DATA.has(option) || option === "--json") {
    if (value.startsWith("@") && option !== "--data-raw")
      return "Bodies read from files (@file) aren't supported";
    draft.data.push(value);
    draft.json ||= option === "--json";
  } else if (option === "-u" || option === "--user") draft.user = value;
  else if (option === "--url") draft.url = value;
  else if (HEADER_VALUES.has(option))
    draft.headers.push({ name: HEADER_VALUES.get(option)!, value });
  else if (!IGNORED_VALUES.has(option)) return `Unsupported curl option ${option}`;

  return undefined;
};

const takesValue = (option: string) =>
  ["-X", "--request", "-H", "--header", "-u", "--user", "--url", "--json"].includes(option) ||
  DATA.has(option) ||
  HEADER_VALUES.has(option) ||
  IGNORED_VALUES.has(option);

/** Short flags written together, such as `-sSL`. */
const combinedFlags = (word: string) =>
  /^-[A-Za-z]{2,}$/.test(word) &&
  word
    .slice(1)
    .split("")
    .every((flag) => IGNORED_FLAGS.has(`-${flag}`));

const readOptions = (words: ReadonlyArray<string>): Result.Result<Draft, string> => {
  const draft: Draft = { headers: [], data: [], json: false };

  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;

    if (!word.startsWith("-") || word === "-") {
      if (draft.url !== undefined) return Result.fail(`Two URLs: ${draft.url} and ${word}`);
      draft.url = word;
      continue;
    }

    if (IGNORED_FLAGS.has(word) || combinedFlags(word)) continue;
    const [option, inline] = splitOption(word);

    if (!takesValue(option)) return Result.fail(`Unsupported curl option ${option}`);
    const value = inline ?? words[++index];

    if (value === undefined) return Result.fail(`${option} needs a value`);
    const failed = applyValue(draft, option, value);

    if (failed) return Result.fail(failed);
  }

  return Result.succeed(draft);
};

const hasHeader = (headers: ReadonlyArray<HttpHeader>, name: string) =>
  headers.some((item) => item.name.toLowerCase() === name.toLowerCase());

/** `--json` adds JSON Content-Type and Accept headers unless the command set its own. */
const jsonHeaders = (draft: Draft) => {
  if (!draft.json) return draft.headers;
  const added = [...draft.headers];

  if (!hasHeader(added, "content-type"))
    added.push({ name: "Content-Type", value: "application/json" });

  if (!hasHeader(added, "accept")) added.push({ name: "Accept", value: "application/json" });

  return added;
};

const userAuth = (user: string) => {
  const colon = user.indexOf(":");

  return colon < 0
    ? RequestAuth.cases.Basic.make({ user, password: "" })
    : RequestAuth.cases.Basic.make({ user: user.slice(0, colon), password: user.slice(colon + 1) });
};

const toRequest = (draft: Draft): Result.Result<AdHocRequest, RequestsError> => {
  const method = draft.method ?? (draft.data.length > 0 ? "POST" : "GET");

  if (!draft.url)
    return Result.fail(curlError("The command has no URL", "Add the URL to the command"));

  if (!isMethod(method))
    return Result.fail(
      curlError(
        `Unsupported method ${method}`,
        "Use GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE"
      )
    );
  const { headers, auth } = authFromHeaders(jsonHeaders(draft));
  // An Authorization header wins over -u, as in curl.
  const chosen = auth ?? (draft.user === undefined ? undefined : userAuth(draft.user));

  const request: AdHocRequest = { method, url: draft.url, headers };

  if (draft.data.length > 0) Object.assign(request, { body: draft.data.join("&") });

  if (chosen) Object.assign(request, { auth: chosen });

  return Result.succeed(request);
};

/** Parses `curl …` as a shell would split it; options it can't honour are errors, not dropped. */
export const parseCurl = (text: string): Result.Result<AdHocRequest, RequestsError> => {
  const words = shellWords(text.trim());

  if (!words)
    return Result.fail(curlError("A quote is never closed", "Close the quote and paste again"));

  if (words[0] !== "curl") return Result.fail(curlError("This isn't a curl command"));
  const draft = readOptions(words.slice(1));

  return Result.flatMap(
    Result.mapError(draft, (message) => curlError(message)),
    toRequest
  );
};

/** Single-quotes a word for a POSIX shell. */
export const shellQuote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const authArgs = (auth: RequestAuth) =>
  Match.valueTags(auth, {
    Bearer: ({ token }) => ["-H", `Authorization: Bearer ${token}`],
    Basic: ({ user, password }) => ["-u", `${user}:${password}`],
  });

/** A resolved Request as a curl command, one option per line, with every secret masked. */
export const formatCurl = (request: AdHocRequest, secrets: ReadonlyArray<string> = []) => {
  const parts: string[][] = [["curl"]];

  if (request.method !== "GET" || request.body !== undefined) parts[0]!.push("-X", request.method);
  parts[0]!.push(request.url);

  for (const item of request.headers) parts.push(["-H", `${item.name}: ${item.value}`]);

  if (request.auth) parts.push(authArgs(request.auth));

  if (request.body !== undefined) parts.push(["--data-raw", request.body]);

  return parts
    .map((words) => words.map((word) => shellQuote(maskSecrets(word, secrets))).join(" "))
    .join(" \\\n  ");
};
