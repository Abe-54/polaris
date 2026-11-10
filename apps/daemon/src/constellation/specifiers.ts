/**
 * Dependency specifiers a merged branch may add before Accept installs from it (ENG-276).
 * Fails closed: a manifest it can't read, or any value it doesn't recognize, refuses.
 */
import { Option, Schema } from "effect";
import { HOOKS_OFF, runGitRaw } from "../git/git.ts";
import { hasDuplicateKeys } from "./duplicateKeys.ts";

/** Keys whose string leaves, at any depth, are specifiers or paths bun install acts on. */
const FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
  "catalog",
  "catalogs",
  "patchedDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

const Manifest = Schema.JsonObject;

const RANGE = /^[A-Za-z0-9~^<>=.*|\- ]*$/;

const PACKAGE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

const range = (spec: string) =>
  RANGE.test(spec) && !spec.startsWith(".") && !/\.(tgz|tar|tar\.gz)$/i.test(spec);

/** A registry range or dist-tag, `workspace:` with one, a named catalog, or an npm alias of one. */
export const fromRegistry = (spec: string): boolean => {
  if (spec.startsWith("workspace:")) return range(spec.slice("workspace:".length));

  if (spec.startsWith("catalog:")) return /^[A-Za-z0-9_-]*$/.test(spec.slice("catalog:".length));

  if (spec.startsWith("npm:")) {
    const alias = spec.slice("npm:".length);
    const at = alias.lastIndexOf("@");
    const name = at > 0 ? alias.slice(0, at) : alias;

    return PACKAGE.test(name) && range(at > 0 ? alias.slice(at + 1) : "");
  }

  return range(spec);
};

const isString = Schema.is(Schema.String);

const isObject = Schema.is(Schema.JsonObject);

const isArray = Schema.is(Schema.Array(Schema.Json));

interface Leaf {
  readonly label: string;
  readonly spec: string | null;
}

/** Every leaf under `value`, keyed by its JSON-encoded path so keys with dots can't collide. */
const leaves = (value: Schema.Json, path: ReadonlyArray<string>, into: Map<string, Leaf>) => {
  if (isArray(value)) value.forEach((v, i) => leaves(v, [...path, String(i)], into));
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) leaves(v, [...path, k], into);
  else
    into.set(JSON.stringify(path), { label: path.join("."), spec: isString(value) ? value : null });
};

interface Read {
  readonly specs: ReadonlyMap<string, Leaf>;
  /** The workspace globs, which choose the manifests bun installs; a change is refused. */
  readonly globs: string;
}

const absent: Read = { specs: new Map(), globs: "null" };

/** A manifest's dependency leaves and workspace globs; null unless strict JSON, keys once each. */
const read = async (root: string, ref: string, path: string): Promise<Read | null> => {
  const shown = await runGitRaw(root, [...HOOKS_OFF, "show", `${ref}:${path}`]);

  if (shown.code !== 0) return absent;

  const text = new TextDecoder().decode(shown.stdout);
  const manifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text);

  if (Option.isNone(manifest) || hasDuplicateKeys(text)) return null;
  const specs = new Map<string, Leaf>();
  const workspaces = manifest.value.workspaces;
  const nested = workspaces !== undefined && isObject(workspaces) ? workspaces : {};

  for (const field of FIELDS) {
    const top = manifest.value[field];
    const inner = nested[field];

    if (top !== undefined) leaves(top, [field], specs);

    if (inner !== undefined) leaves(inner, ["workspaces", field], specs);
  }

  const packages =
    workspaces !== undefined && isObject(workspaces) ? workspaces.packages : workspaces;

  return { specs, globs: JSON.stringify(packages ?? null) };
};

/** What `manifests` gain from HEAD to the merged index that bun could fetch off the registry. */
export const addedOffRegistry = async (root: string, manifests: ReadonlyArray<string>) => {
  const added: Array<string> = [];

  for (const path of manifests) {
    const theirs = await read(root, "", path);

    if (theirs === null) {
      added.push(`${path}: not strict JSON, or repeats a key`);
      continue;
    }

    const ours = (await read(root, "HEAD", path)) ?? absent;

    if (ours.globs !== theirs.globs) added.push(`${path}: workspaces`);

    for (const [key, { label, spec }] of theirs.specs)
      if (ours.specs.get(key)?.spec !== spec && (spec === null || !fromRegistry(spec)))
        added.push(`${path}: ${label}@${spec ?? "(not a string)"}`);
  }

  return added;
};
