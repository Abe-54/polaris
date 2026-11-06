/**
 * Rehype steps that mark Markdown images naming a path (absolute, `~/…`, `file://`, or relative
 * to the session's directory) so the `img` component reads them from the session's Host. URLs
 * are left to Streamdown as before. See `HostImage.tsx`.
 */
import { Option, Schema } from "effect";
import type { Node } from "./softBreaks.ts";

/** A hast property value, as rehype keeps them. */
export type PropertyValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | null
  | undefined;

export interface MutableElement {
  readonly type: "element";
  readonly tagName: string;
  properties?: Record<string, PropertyValue>;
  children?: Array<Node>;
}

/** What a marked image's `src` becomes, so the hardening step lets it through untouched. */
export const HOST_IMAGE_SRC = "polaris-host:image";

const HostImageMark = Schema.Struct({
  src: Schema.Literal(HOST_IMAGE_SRC),
  dataHostPath: Schema.String,
});

const markOf = Schema.decodeUnknownOption(HostImageMark);

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const WINDOWS_ABSOLUTE = /^\/?[A-Za-z]:[\\/]/;

const windowsPath = (path: string) =>
  path.replace(/^\/(?=[A-Za-z]:[\\/])/, "").replaceAll("\\", "/");

const isElement = (node: Node): node is MutableElement => node.type === "element";

export const each = (node: Node, visit: (element: MutableElement) => void) => {
  if (isElement(node)) visit(node);

  if ("children" in node && Array.isArray(node.children))
    for (const child of node.children) each(child, visit);
};

const Sourced = Schema.Struct({ src: Schema.String });

const sourceOf = Schema.decodeUnknownOption(Sourced);

const eachImage = (tree: Node, visit: (image: MutableElement, src: string) => void) =>
  each(tree, (element) => {
    if (element.tagName !== "img") return;
    const source = sourceOf(element.properties);

    if (Option.isSome(source)) visit(element, source.value.src);
  });

/** A `file://` URL on this Host's own disk as its (still encoded) path; null for anything else. */
export const fileUrlPath = (src: string): string | null => {
  if (!/^file:/i.test(src)) return null;

  try {
    const url = new URL(src);

    return url.host === "" || url.host === "localhost" ? url.pathname : null;
  } catch {
    return null;
  }
};

const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/** A file URL or Windows drive path made safe to carry through Markdown's URL sanitizer. */
export const sanitizableHostPath = (source: string): string | null => {
  const file = fileUrlPath(source);

  if (file !== null) return file;

  return /^[A-Za-z]:[\\/]/.test(decoded(source)) ? `/${source}` : null;
};

/** The Host path an image source names, decoded; null for a URL, a fragment or nothing. */
export const hostPathOf = (src: string): string | null => {
  const file = fileUrlPath(src);
  const path = decoded(file ?? src);

  if (WINDOWS_ABSOLUTE.test(path)) return windowsPath(path);

  if (file !== null) return path;

  if (
    src === "" ||
    path.startsWith("//") ||
    path.startsWith("\\\\") ||
    src.startsWith("#") ||
    SCHEME.test(src)
  )
    return null;

  return path;
};

/** Before sanitizing, preserve file URLs and Windows drives as paths rather than URL schemes. */
export const rehypeFileImages = () => (tree: Node) =>
  eachImage(tree, (image, src) => {
    const path = sanitizableHostPath(src);

    if (path !== null && image.properties !== undefined) image.properties["src"] = path;
  });

/** After sanitizing, before hardening (which drops relative and `~` sources): marks Host images. */
export const rehypeHostImages = () => (tree: Node) =>
  eachImage(tree, (image, src) => {
    const path = hostPathOf(src);

    if (path === null || image.properties === undefined) return;
    image.properties["src"] = HOST_IMAGE_SRC;
    image.properties["dataHostPath"] = path;
  });

/** The Host path a marked image reads; null for an image Streamdown shows itself. */
export const hostImageOf = (
  properties: Readonly<Record<string, PropertyValue>> | undefined
): string | null =>
  Option.match(markOf(properties), {
    onNone: () => null,
    onSome: (mark) => mark.dataHostPath,
  });

/** The path on the Host: as written when absolute or under `~`, else under `root`; null without one. */
export const onHost = (root: string | null, path: string): string | null => {
  if (WINDOWS_ABSOLUTE.test(path)) return windowsPath(path);

  if (path.startsWith("/") || path === "~" || path.startsWith("~/")) return path;

  if (root === null) return null;

  const windows = WINDOWS_ABSOLUTE.test(root);
  const directory = windows ? windowsPath(root) : root;
  const relative = windows ? path.replaceAll("\\", "/") : path;

  return `${directory.replace(/\/+$/, "")}/${relative.replace(/^(\.\/)+/, "")}`;
};
