/**
 * A Polaris tool call in the conversation (DESIGN.md, Polaris tools in the conversation): the
 * Constellation mark, the verb and its subject in glossary words, folded to one line. It opens
 * to what the call carried and Polaris's reply; the raw call stays behind Show raw.
 */
import { Button, cn, DisclosureChevron, Dither, type Harness } from "@polaris/ui";
import { useMemo, useState } from "react";
import { useApp } from "../../../../shell/hooks.ts";
import { useBanner } from "../../banners.ts";
import { useSessionChrome } from "../../chrome.ts";
import { chooseCollapse, collapseChoice } from "../../model/collapse.ts";
import { type PolarisToolView, withBanner } from "../../model/polarisTools/index.ts";
// The glyph alone: the Constellation feature's index imports the session feature.
import { ConstellationMark } from "../../../constellation/ui/glyphs.tsx";
import { Segments, RawBody, RefusalBody, WellBody } from "./well.tsx";
import { useOpenSession, useSessionTarget } from "./target.ts";

export { SessionTargetContext } from "./target.ts";

type Hue = Harness | null;

/** A refusal's glyph: neutral, the agent reads the fix and retries. */
const Stopped = () => (
  <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden className="text-text-faint shrink-0">
    <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.25" />
    <path d="M3.75 6h4.5" stroke="currentColor" strokeWidth="1.25" />
  </svg>
);

const Mark = ({ view, hue }: { readonly view: PolarisToolView; readonly hue: Hue }) => {
  if (view.phase === "pending") return hue === null ? null : <Dither hue={hue} size={12} moving />;

  if (view.phase === "refused") return <Stopped />;

  return <ConstellationMark size={12} className="text-text-subtle shrink-0" />;
};

/** A sent notification's banner record and the session it came from, for its preview. */
const useNotice = (view: PolarisToolView) => {
  const target = useSessionTarget();
  const notice = view.phase === "done" ? view.notice : null;
  const banner = useBanner(target === null || notice === null ? null : { ...target, ...notice });

  const from = useApp((s) => {
    if (notice === null || target === null) return null;

    const title = s.hostModels[target.hostKey]?.sessions.get(target.sessionId)?.session.title;
    const host = s.hosts.find((h) => h.key === target.hostKey)?.label;

    return [title, host].filter((part) => part !== undefined).join(" · ") || null;
  });

  return { banner, from };
};

const Foot = ({
  view,
  raw,
  onRaw,
}: {
  readonly view: PolarisToolView;
  readonly raw: boolean;
  readonly onRaw: () => void;
}) => {
  const { openTask } = useSessionChrome();
  const openSession = useOpenSession();
  const links = openTask === undefined ? [] : view.links;
  const sessions = openSession === null ? [] : view.sessions;

  return (
    <div className="border-hairline flex min-w-0 items-center gap-1 border-t pt-1.5">
      <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">{view.reply}</span>
      {links.map((link) => (
        <Button key={link.taskId} variant="ghost" size="sm" onClick={() => openTask?.(link.taskId)}>
          {link.label}
        </Button>
      ))}
      {sessions.map((session) => (
        <Button
          key={session.id}
          variant="ghost"
          size="sm"
          title={session.id}
          onClick={() => openSession?.(session.id)}
        >
          Open {session.title}
        </Button>
      ))}
      <Button variant="ghost" size="sm" onClick={onRaw} data-testid="polaris-tool-show-raw">
        {raw ? "Hide raw" : "Show raw"}
      </Button>
    </div>
  );
};

const Line = ({
  view,
  hue,
  open,
  onToggle,
}: {
  readonly view: PolarisToolView;
  readonly hue: Hue;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => (
  <button
    type="button"
    aria-expanded={open}
    onClick={onToggle}
    className="group/polaris flex h-6 min-w-0 cursor-default items-center gap-2 text-left"
  >
    <Mark view={view} hue={hue} />
    <span
      className={cn(
        "text-caption shrink-0 font-medium",
        view.phase === "refused" ? "text-text-subtle" : "text-text-default"
      )}
    >
      {view.verb}
    </span>
    {view.subject === null ? null : (
      <Segments
        segments={[view.subject]}
        className={cn(
          "text-caption max-w-[45%] min-w-0 shrink-0",
          view.phase === "refused" ? "text-text-faint" : "text-text-subtle"
        )}
      />
    )}
    <Segments
      segments={view.detail}
      className={cn(
        "text-caption min-w-0",
        view.phase === "refused" ? "text-text-faint" : "text-text-subtle"
      )}
    />
    <span className="flex-1" />
    {view.caption === null ? null : (
      <span className="text-caption text-text-subtle shrink-0">{view.caption}</span>
    )}
    <DisclosureChevron
      open={open}
      className={
        open ? "text-text-faint" : "text-text-subtle opacity-60 group-hover/polaris:opacity-100"
      }
    />
  </button>
);

export const PolarisTool = ({
  id,
  view: called,
  hue,
}: {
  readonly id: string;
  readonly view: PolarisToolView;
  readonly hue: Hue;
}) => {
  const { banner, from } = useNotice(called);
  const [open, setOpen] = useState(() => collapseChoice(`polaris:${id}`) ?? false);
  const [raw, setRaw] = useState(false);
  const view = useMemo(() => withBanner(called, banner), [called, banner]);

  const toggle = () => {
    chooseCollapse(`polaris:${id}`, !open);
    setOpen(!open);
  };

  return (
    <div
      className="flex min-w-0 flex-col"
      data-testid="polaris-tool"
      data-item={id}
      data-tool={view.tool}
      data-phase={view.phase}
    >
      <Line view={view} hue={hue} open={open} onToggle={toggle} />
      {open ? (
        <div className="rounded-row border-hairline bg-surface-sunken mt-1 ml-5 flex min-w-0 flex-col gap-1.5 border px-3 py-2.5">
          {view.refusal === null ? null : <RefusalBody refusal={view.refusal} />}
          {view.well === null || raw ? null : <WellBody well={view.well} from={from} />}
          {raw ? <RawBody raw={view.raw} /> : null}
          <Foot view={view} raw={raw} onRaw={() => setRaw(!raw)} />
        </div>
      ) : null}
    </div>
  );
};
