/**
 * An assistant message as Markdown (Streamdown): incomplete syntax mid-stream
 * renders as it will end, code in the code font with a copy action, Mermaid
 * and KaTeX once their plugins load, links open in the browser, images and links naming a path
 * open from the session's Host.
 */
import "./markdown.css";
import {
  type Components,
  type ControlsConfig,
  defaultComponents,
  defaultRehypePlugins,
  Streamdown,
} from "streamdown";
import { FileLink } from "../../../editor-links/index.ts";
import { COPY_CODE, COPY_TABLE } from "./copyControls.tsx";
import { editorLinkOf, rehypeFileLinks } from "./fileLinks.ts";
import { HostImage } from "./HostImage.tsx";
import { hostImageOf, rehypeFileImages, rehypeHostImages } from "./hostImages.ts";
import { HostLink } from "./HostLink.tsx";
import { hostLinkOf, rehypeFileHrefs, rehypeHostLinks } from "./hostLinks.ts";
import { needsOf } from "./needs.ts";
import { rehypeSoftBreaks } from "./softBreaks.ts";
import { usePlugins } from "./plugins.ts";
import { MERMAID_CONFIG, POLARIS_SHIKI } from "./theme.ts";

// Copy is Polaris's own CopyButton (`copyControls.tsx`), not Streamdown's.
const CONTROLS: ControlsConfig = {
  code: { copy: false, download: false },
  table: { copy: false, download: false, fullscreen: false },
  mermaid: { copy: false, download: false, fullscreen: false, panZoom: false },
};

const { raw, sanitize, harden } = defaultRehypePlugins;

// Host images and links are marked between sanitizing and hardening; `<wbr>` and editor links after.
const REHYPE = [
  raw,
  rehypeFileImages,
  rehypeFileHrefs,
  sanitize,
  rehypeHostImages,
  rehypeHostLinks,
  harden,
  rehypeFileLinks,
  rehypeSoftBreaks,
].filter((plugin) => plugin !== undefined);

const COMPONENTS: Components = {
  ...COPY_CODE,
  ...COPY_TABLE,
  // A path reads from the session's Host; a URL is Streamdown's own image, as it always was.
  img: (props) => {
    const path = hostImageOf(props.node?.properties);

    return path === null ? (
      <defaultComponents.img {...props} />
    ) : (
      <HostImage path={path} alt={props.alt ?? ""} />
    );
  },
  // `path:line` (rehypeFileLinks) opens in the editor, a Host path as `HostLink` says, other
  // web links in the user's browser (HTTP or HTTPS, including localhost).
  a: ({ href, children, node }) => {
    const target = editorLinkOf(node?.properties);
    const hostPath = hostLinkOf(node?.properties);

    if (hostPath !== null) return <HostLink path={hostPath}>{children}</HostLink>;

    if (target !== null)
      return (
        <FileLink
          path={target.path}
          line={target.line}
          column={target.column}
          className="text-text-strong decoration-text-faint hover:decoration-text-subtle inline underline underline-offset-2"
        >
          {children}
        </FileLink>
      );

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-text-strong decoration-text-faint hover:decoration-text-subtle underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
};

export interface StreamedProps {
  readonly text: string;
  readonly live: boolean;
}

const Streamed = ({ text, live }: StreamedProps) => {
  const plugins = usePlugins(needsOf(text));

  return (
    <Streamdown
      className="polaris-md"
      isAnimating={live}
      plugins={plugins}
      rehypePlugins={REHYPE}
      components={COMPONENTS}
      controls={CONTROLS}
      shikiTheme={[POLARIS_SHIKI, POLARIS_SHIKI]}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
      {...(plugins.mermaid === undefined ? {} : { mermaid: { config: MERMAID_CONFIG } })}
    >
      {text}
    </Streamdown>
  );
};

export default Streamed;
