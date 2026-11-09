/** A checkout's request files, environments and `.env` values, read through the bounded safe reader. */
import { posix } from "node:path";
import { RequestsError, type RequestsSnapshot } from "@polaris/protocol";
import { Result } from "effect";
import { ENV_FILES, envValues } from "../../data/env.ts";
import { checkoutFiles } from "../../data/packages.ts";
import { read } from "../../data/read.ts";
import {
  ENV_FILE,
  PRIVATE_ENV_FILE,
  environmentNames,
  environmentValues,
  parseEnvironments,
  type Environments,
} from "./environments.ts";
import { parseDocument, type RequestDocument } from "./parse.ts";
import type { VariableSources } from "./variables.ts";

/** Request files may be larger than the 64 KiB other checkout reads allow. */
export const REQUEST_FILE_LIMIT = 1024 * 1024;

export const isRequestFile = (path: string) => /\.(?:http|rest)$/i.test(path);

/** Every `.http` and `.rest` file in the checkout that isn't gitignored, sorted. */
export const listRequestFiles = async (checkout: string, signal?: AbortSignal) =>
  (await checkoutFiles(checkout, signal)).filter(isRequestFile).sort();

export const loadRequestFiles = async (
  checkout: string,
  signal?: AbortSignal
): Promise<RequestDocument[]> => {
  const documents: RequestDocument[] = [];

  for (const path of await listRequestFiles(checkout, signal)) {
    signal?.throwIfAborted();
    documents.push(parseDocument(await read(checkout, path, REQUEST_FILE_LIMIT), path));
  }

  return documents;
};

const at = (dir: string, file: string) => (dir === "." || dir === "" ? file : `${dir}/${file}`);

/** `dir` and each directory above it up to the checkout root, nearest first. */
const ancestors = (dir: string) => {
  const dirs = [dir];

  for (let current = dir; current !== "." && current !== "";) {
    current = posix.dirname(current);
    dirs.push(current);
  }

  return dirs;
};

interface EnvTexts {
  readonly dir: string;
  readonly public: string;
  readonly private: string;
}

/** The env files nearest a request file: its own directory's, or the closest parent's. */
const envTexts = async (checkout: string, dir: string): Promise<EnvTexts> => {
  for (const candidate of ancestors(dir)) {
    const texts = {
      dir: candidate,
      public: await read(checkout, at(candidate, ENV_FILE)),
      private: await read(checkout, at(candidate, PRIVATE_ENV_FILE)),
    };

    if (texts.public !== "" || texts.private !== "") return texts;
  }

  return { dir: ".", public: "", private: "" };
};

const environments = (texts: EnvTexts) =>
  Result.all({
    public: parseEnvironments(texts.public, at(texts.dir, ENV_FILE)),
    private: parseEnvironments(texts.private, at(texts.dir, PRIVATE_ENV_FILE)),
  });

/** What `requests.watch` sends: the files and every environment their env files define. */
export const loadSnapshot = async (
  checkout: string,
  signal?: AbortSignal
): Promise<{ snapshot: RequestsSnapshot; documents: RequestDocument[] }> => {
  const documents = await loadRequestFiles(checkout, signal);
  const dirs = new Set([".", ...documents.map((doc) => posix.dirname(doc.file.path))]);
  const found: Environments[] = [];

  for (const dir of dirs) {
    const parsed = environments(await envTexts(checkout, dir));

    if (Result.isSuccess(parsed)) found.push(parsed.success.public, parsed.success.private);
  }

  return {
    documents,
    snapshot: { files: documents.map((doc) => doc.file), environments: environmentNames(...found) },
  };
};

/** `.env` values for `{{$dotenv}}`: the root's files, then the request file's own directory's over them. */
export const dotenvValues = async (checkout: string, path: string) => {
  const dir = posix.dirname(path);
  const dirs = dir === "." ? ["."] : [".", dir];
  const values: Record<string, string> = {};

  for (const from of dirs)
    for (const file of ENV_FILES)
      Object.assign(values, envValues(await read(checkout, at(from, file))));

  return values;
};

/** Everything `resolveRequest` needs for a Request in `path` (or an ad-hoc one at the root). */
export const variableSources = async (
  checkout: string,
  path: string | undefined,
  fileVariables: Readonly<Record<string, string>>,
  environment: string | undefined
): Promise<Result.Result<VariableSources, RequestsError>> => {
  const dir = path === undefined ? "." : posix.dirname(path);
  const parsed = environments(await envTexts(checkout, dir));

  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const values = environmentValues(parsed.success.public, parsed.success.private, environment);

  if (!values)
    return Result.fail(
      new RequestsError({
        code: "E-ENVIRONMENT-NOT-FOUND",
        message: `No environment named ${environment} in ${ENV_FILE}`,
        fix: `Add "${environment}" to ${ENV_FILE}, or pick another environment`,
      })
    );

  return Result.succeed({
    file: fileVariables,
    public: values.public,
    private: values.private,
    dotenv: await dotenvValues(checkout, path ?? "."),
  });
};

/** File-level `@var` values of a parsed file; a later definition wins. */
export const fileVariables = (document: RequestDocument) =>
  Object.fromEntries(document.variables.map((variable) => [variable.name, variable.value]));
