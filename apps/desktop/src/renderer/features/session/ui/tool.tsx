/**
 * A tool call that isn't Polaris's own (DESIGN.md, Tool runs): its verb ("Called Paper",
 * "Loaded", "Read") and subject on one line. It opens to what the call returned (a line, a
 * link, its images) and, behind Show raw, the call as the Harness sent it. An image it viewed or
 * made shows under it, read from the session's Host.
 */
import { JsonText, looksLikeJson } from "./json.tsx";
import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  cn,
  LiveDither,
  PixelFailedIcon,
} from "@polaris/ui";
import { Predicate } from "effect";
import { useState } from "react";
// The glyph alone: the Constellation feature's index imports the session feature.
import { ConstellationMark } from "../../constellation/ui/glyphs.tsx";
import { FileLink } from "../../editor-links/index.ts";
import { chooseCollapse, collapseChoice } from "../model/collapse.ts";
import type { ItemView } from "../model/items.ts";
import { toolLabel } from "../model/runs.ts";
import type { ToolOutput } from "../model/toolCalls/index.ts";
import { ImageViewer } from "./ImageViewer.tsx";
import { HostImage } from "./markdown/HostImage.tsx";
import { type Hue, LiveMark } from "./marks.tsx";
import { RawBody } from "./polarisTool/well.tsx";

type ToolView = Extract<ItemView, { kind: "tool" }>;

const ToolMark = ({ item, hue }: { item: ToolView; hue: Hue }) => {
  if (item.status === "running") return <LiveMark hue={hue} />;

  if (item.status === "completed" && item.polaris)
    return <ConstellationMark size={12} className="text-text-subtle" />;

  return item.status === "completed" ? (
    <CheckIcon size={12} className="text-text-faint" />
  ) : (
    <PixelFailedIcon size={12} className="text-failed" />
  );
};

/** A tool's subject: an image opens in the viewer, another file in the editor, else plain text. */
const Subject = ({ item }: { readonly item: ToolView }) => {
  const [viewing, setViewing] = useState(false);
  const text = "text-code-inline text-text-subtle font-mono";

  if (item.file === null)
    return (
      <span className={cn(text, "truncate")} title={item.full}>
        {item.summary}
      </span>
    );

  if (!item.file.image)
    return (
      <FileLink path={item.file.path} line={item.file.line} className={text}>
        {item.summary}
      </FileLink>
    );

  return (
    <>
      <button
        type="button"
        onClick={() => setViewing(true)}
        title="View image"
        data-testid="image-link"
        className={cn(
          text,
          "hover:text-text-strong min-w-0 cursor-pointer truncate text-left underline-offset-2 hover:underline focus-visible:underline"
        )}
      >
        {item.summary}
      </button>
      {viewing ? <ImageViewer path={item.file.path} onClose={() => setViewing(false)} /> : null}
    </>
  );
};

/** A tool that names a text file: its menu opens or reveals that file. */
const textFile = (item: ToolView) => (item.file === null || item.file.image ? null : item.file);

const pretty = (value: ToolOutput) => {
  if (value === null || value === undefined) return "";

  return Predicate.isString(value) ? value : (JSON.stringify(value, null, 2) ?? "");
};

/** What the call returned: its line, a link in it, its images; or that it returned nothing. */
const Result = ({ item }: { readonly item: ToolView }) => {
  const { result } = item;

  if (result === null) return <span className="text-caption text-text-subtle">No result</span>;

  return (
    <>
      {result.text === null ? null : (
        <p
          className={cn(
            "text-text-default wrap-anywhere whitespace-pre-wrap",
            looksLikeJson(result.text) ? "text-code-inline font-mono" : "text-caption"
          )}
        >
          <JsonText text={result.text} />
        </p>
      )}
      {result.link === null ? null : (
        <a
          href={result.link}
          target="_blank"
          rel="noreferrer"
          className="text-caption text-text-strong decoration-text-faint hover:decoration-text-subtle truncate underline underline-offset-2"
        >
          {result.link}
        </a>
      )}
      {result.images.length === 0 ? null : (
        <div className="flex flex-wrap gap-2" data-testid="tool-result-images">
          {result.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt=""
              className="rounded-row border-hairline max-h-24 max-w-48 border object-contain"
            />
          ))}
        </div>
      )}
    </>
  );
};

const Details = ({ item }: { readonly item: ToolView }) => {
  const [raw, setRaw] = useState(false);

  return (
    <div className="rounded-row border-hairline bg-surface-sunken mt-1 ml-5 flex min-w-0 flex-col gap-1.5 border px-3 py-2.5">
      {raw ? (
        <RawBody
          raw={{ name: item.name, input: pretty(item.input), output: pretty(item.output) }}
          testId="tool-raw"
        />
      ) : (
        <Result item={item} />
      )}
      <div className="border-hairline flex min-w-0 items-center justify-end border-t pt-1.5">
        <Button variant="ghost" size="sm" onClick={() => setRaw(!raw)} data-testid="tool-show-raw">
          {raw ? "Hide raw" : "Show raw"}
        </Button>
      </div>
    </div>
  );
};

export const Tool = ({ item, hue }: { readonly item: ToolView; readonly hue: Hue }) => {
  const key = `tool:${item.id}`;
  // A failed call opens on its error; the user's choice wins.
  const [open, setOpen] = useState(() => collapseChoice(key) ?? item.status === "failed");
  const opens = item.status !== "running";
  const live = item.status === "running" ? hue : null;

  const toggle = () => {
    chooseCollapse(key, !open);
    setOpen(!open);
  };

  return (
    <div className="flex min-w-0 flex-col" data-testid="tool-call" data-status={item.status}>
      <div
        className={cn(
          "relative isolate flex h-6 min-w-0 items-center gap-2",
          live !== null && "rounded-row -mx-1.5 overflow-clip px-1.5"
        )}
        data-menu-path={textFile(item)?.path}
        data-menu-line={textFile(item)?.line ?? undefined}
      >
        {live === null ? null : <LiveDither harness={live} active className="-z-10" />}
        <ToolMark item={item} hue={hue} />
        <button
          type="button"
          disabled={!opens}
          aria-expanded={opens ? open : undefined}
          onClick={toggle}
          className="text-caption text-text-subtle enabled:hover:text-text-default shrink-0 cursor-default font-medium"
        >
          {toolLabel(item)}
        </button>
        <Subject item={item} />
        {item.status === "declined" ? (
          <span className="text-caption text-text-subtle shrink-0">declined</span>
        ) : null}
        {opens ? (
          <button
            type="button"
            aria-label={open ? "Hide details" : "Show details"}
            onClick={toggle}
            className="shrink-0 cursor-default"
          >
            {open ? (
              <ChevronDownIcon size={10} className="text-text-faint" />
            ) : (
              <ChevronRightIcon size={10} className="text-text-faint" />
            )}
          </button>
        ) : null}
      </div>
      {item.file?.image === true && item.status === "completed" ? (
        <div className="text-caption mt-1 mb-1 ml-5 flex min-w-0" data-testid="tool-image">
          <HostImage
            path={item.file.path}
            alt=""
            className="rounded-row border-hairline bg-surface-sunken block h-auto max-h-[180px] w-auto max-w-[min(100%,240px)] border object-contain"
          />
        </div>
      ) : null}
      {open && opens ? <Details item={item} /> : null}
    </div>
  );
};
