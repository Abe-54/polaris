/**
 * Rehype steps that mark Markdown links naming a path (absolute, `~/…`, `file://`, or relative to
 * the session's directory) so the `a` component opens them on the session's Host: an image in the
 * viewer, any other file in the editor. URLs are left as they were. See `HostLink.tsx`.
 */
import { Option, Schema } from "effect";
import {
  each,
  sanitizableHostPath,
  hostPathOf,
  type HostPaths,
  type MutableElement,
  type PropertyValue,
} from "./hostImages.ts";
import type { Node } from "./softBreaks.ts";

/** What a marked link's `href` becomes, so the hardening step lets it through untouched. */
export const HOST_LINK_HREF = "polaris-host:link";

const HostLinkMark = Schema.Struct({
  href: Schema.Literal(HOST_LINK_HREF),
  dataHostPath: Schema.String,
});

const markOf = Schema.decodeUnknownOption(HostLinkMark);

const Linked = Schema.Struct({ href: Schema.String });

const hrefOf = Schema.decodeUnknownOption(Linked);

const eachLink = (tree: Node, visit: (link: MutableElement, href: string) => void) =>
  each(tree, (element) => {
    if (element.tagName !== "a") return;
    const link = hrefOf(element.properties);

    if (Option.isSome(link)) visit(element, link.value.href);
  });

/** Before sanitizing, preserve file URLs and Windows drives as paths rather than URL schemes. */
export const rehypeFileHrefs =
  ({ windows }: HostPaths) =>
  (tree: Node) =>
    eachLink(tree, (link, href) => {
      const path = sanitizableHostPath(href, windows);

      if (path !== null && link.properties !== undefined) link.properties["href"] = path;
    });

/** After sanitizing, before hardening (which would send a path to the window as a URL). */
export const rehypeHostLinks =
  ({ windows }: HostPaths) =>
  (tree: Node) =>
    eachLink(tree, (link, href) => {
      const path = href.startsWith("?") ? null : hostPathOf(href, windows);

      if (path === null || link.properties === undefined) return;
      link.properties["href"] = HOST_LINK_HREF;
      link.properties["dataHostPath"] = path;
    });

/** The Host path a marked link opens; null for a link to a URL. */
export const hostLinkOf = (
  properties: Readonly<Record<string, PropertyValue>> | undefined
): string | null =>
  Option.match(markOf(properties), {
    onNone: () => null,
    onSome: (mark) => mark.dataHostPath,
  });
