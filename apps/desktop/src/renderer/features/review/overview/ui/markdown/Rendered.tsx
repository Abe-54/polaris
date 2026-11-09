/**
 * Review Markdown through Streamdown: GFM, raw HTML sanitized (`<details>` kept, comments
 * dropped), then `rehypeReview` for alerts, `diff` blocks, folded tables and path links.
 * Links into the Review go to `renderLink`; others open in the browser.
 */
import "../../../../session/ui/markdown/markdown.css";
import "./review-md.css";
import { type ReactNode, useMemo } from "react";
import { type Components, defaultRehypePlugins, Streamdown } from "streamdown";
import { COPY_CODE } from "../../../../session/ui/markdown/copyControls.tsx";
import { needsOf } from "../../../../session/ui/markdown/needs.ts";
import { usePlugins } from "../../../../session/ui/markdown/plugins.ts";
import { POLARIS_SHIKI } from "../../../../session/ui/markdown/theme.ts";
import { linkOf, prepareMarkdown, type ReviewLink, rehypeReview } from "../../model/markdown.ts";

export interface RenderedProps {
  readonly markdown: string;
  /** The Review's changed paths: inline code and plain blocks naming one link into Changes. */
  readonly paths: ReadonlyArray<string>;
  readonly renderLink: (link: ReviewLink, children: ReactNode) => ReactNode;
}

const Rendered = ({ markdown, paths, renderLink }: RenderedProps) => {
  const text = prepareMarkdown(markdown);
  const plugins = usePlugins({ ...needsOf(text), mermaid: false, math: false });

  const rehype = useMemo(
    () => [...Object.values(defaultRehypePlugins), rehypeReview(paths)],
    [paths]
  );

  const components: Components = {
    ...COPY_CODE,
    a: ({ href, children }) => {
      const link = linkOf(href ?? "");

      return link.kind === "external" ? (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="text-text-strong decoration-text-faint hover:decoration-text-subtle underline underline-offset-2"
        >
          {children}
        </a>
      ) : (
        renderLink(link, children)
      );
    },
  };

  return (
    <Streamdown
      className="polaris-md review-md"
      mode="static"
      plugins={plugins.code === undefined ? {} : { code: plugins.code }}
      rehypePlugins={rehype}
      components={components}
      controls={{ code: { copy: false, download: false }, table: false }}
      tableMaxHeight={0}
      shikiTheme={[POLARIS_SHIKI, POLARIS_SHIKI]}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
    >
      {text}
    </Streamdown>
  );
};

export default Rendered;
