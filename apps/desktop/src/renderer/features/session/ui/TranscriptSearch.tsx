/**
 * ⌘F in a transcript: a find bar over the conversation's top edge. Matches come from
 * the model (`model/search.ts`), so folded Turns and rows outside the viewport count;
 * stepping to one opens its Turn and scrolls it in. Rendered matches are lit with the
 * CSS Custom Highlight API, neutral as the editor's find (DESIGN.md, Find and replace).
 */
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, cn, SearchIcon } from "@polaris/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TurnView } from "../../../store/sessionModel.ts";
import { findInTranscript, type Hit } from "../model/search.ts";
import { shortcutLabel } from "../../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../../shared/keymap.ts";

const MATCH = "transcript-match";

const CURRENT = "transcript-current";

const STYLE = `::highlight(${MATCH}) { background-color: color-mix(in oklab, var(--color-text-strong) 14%, transparent); }
::highlight(${CURRENT}) { background-color: color-mix(in oklab, var(--color-text-strong) 26%, transparent); color: var(--color-text-strong); }`;

/** Every occurrence of `query` inside one text node of `root`. */
const rangesIn = (root: HTMLElement, query: string, matchCase: boolean): Array<Range> => {
  if (query === "") return [];
  const needle = matchCase ? query : query.toLowerCase();
  const ranges: Array<Range> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const haystack = matchCase ? text : text.toLowerCase();

    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const range = document.createRange();

      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at += needle.length - 1;
    }
  }

  return ranges;
};

/** Lights the rendered matches and returns the current one's range, when it is rendered. */
const paint = (list: HTMLElement, query: string, matchCase: boolean, current: Hit | null) => {
  const all: Array<Range> = [];
  let found: Range | null = null;

  for (const row of list.querySelectorAll<HTMLElement>("[data-row-key]")) {
    const ranges = rangesIn(row, query, matchCase);

    all.push(...ranges);

    if (current !== null && row.dataset.rowKey === current.rowKey)
      found = ranges[Math.min(current.occurrence, ranges.length - 1)] ?? null;
  }

  CSS.highlights.set(MATCH, new Highlight(...all));
  CSS.highlights.set(CURRENT, found === null ? new Highlight() : new Highlight(found));

  return found;
};

/** Scrolls the list just enough to show the range, when it is outside the viewport. */
const showRange = (list: HTMLElement, range: Range) => {
  const box = range.getBoundingClientRect();
  const view = list.getBoundingClientRect();
  const margin = 48;

  if (box.top < view.top + margin) list.scrollBy({ top: box.top - view.top - margin });
  else if (box.bottom > view.bottom - margin)
    list.scrollBy({ top: box.bottom - view.bottom + margin });
};

/** Keeps the highlights in step with the virtualized rows as they mount and stream. */
const useHighlights = (
  host: HTMLElement | null,
  query: string,
  matchCase: boolean,
  current: Hit | null
) => {
  useEffect(() => {
    const list = host?.querySelector<HTMLElement>('[data-testid="conversation"]');

    // An empty query matches everywhere (`indexOf("")`): nothing to light.
    if (list === null || list === undefined || query === "" || !("highlights" in CSS)) return;
    let frame = 0;
    // The current match is scrolled to once, when it first renders; not on every repaint.
    let pending = current !== null;

    const run = () => {
      frame = 0;
      const found = paint(list, query, matchCase, current);

      if (pending && found !== null) {
        pending = false;
        showRange(list, found);
      }
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(run);
    };

    const observer = new MutationObserver(schedule);

    observer.observe(list, { childList: true, subtree: true, characterData: true });
    schedule();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete(MATCH);
      CSS.highlights.delete(CURRENT);
    };
  }, [host, query, matchCase, current]);
};

const IconButton = ({
  label,
  onClick,
  disabled = false,
  pressed,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly children: ReactNode;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "rounded-control grid h-6 min-w-6 shrink-0 cursor-default place-items-center px-1 disabled:opacity-40",
      pressed === true
        ? "bg-fill-selected text-text-strong"
        : "text-text-subtle enabled:hover:bg-fill-hover"
    )}
  >
    {children}
  </button>
);

const countLabel = (query: string, total: number, index: number) => {
  if (query.trim() === "") return "";

  return total === 0 ? "No matches" : `${index + 1} of ${total}`;
};

export interface TranscriptSearchProps {
  readonly turns: ReadonlyArray<TurnView>;
  /** What holds the conversation list, for lighting matches. */
  readonly host: HTMLElement | null;
  /** Asks again for focus: ⌘F while the bar is already open. */
  readonly focusNonce: number;
  /** Bring a match into view: open its Turn and scroll to its row. */
  readonly onReveal: (hit: Hit) => void;
  readonly onClose: () => void;
}

export const TranscriptSearch = ({
  turns,
  host,
  focusNonce,
  onReveal,
  onClose,
}: TranscriptSearchProps) => {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(query);

  const hits = useMemo(
    () => findInTranscript(turns, deferred, { matchCase }),
    [turns, deferred, matchCase]
  );

  const current = hits[Math.min(index, hits.length - 1)] ?? null;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  // A new query starts from the first match.
  useEffect(() => {
    setIndex(0);
  }, [deferred, matchCase]);

  // Only a different match scrolls; a streaming Turn changing `hits` must not.
  const currentKey = current === null ? null : `${current.rowKey}#${current.occurrence}`;

  useEffect(() => {
    if (current !== null) onReveal(current);
  }, [currentKey]);

  useHighlights(host, deferred, matchCase, current);

  const step = (by: number) => {
    if (hits.length > 0)
      setIndex((i) => (Math.min(i, hits.length - 1) + by + hits.length) % hits.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") onClose();
    else if (event.key === "Enter") step(event.shiftKey ? -1 : 1);
    else if (event.altKey && event.code === "KeyC") setMatchCase((v) => !v);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      role="search"
      aria-label="Find in transcript"
      className="rounded-card border-hairline bg-surface-raised shadow-float absolute top-2 right-5 z-10 flex w-[340px] max-w-[calc(100%-40px)] items-center gap-1 border py-1 pr-1 pl-2.5"
      data-testid="transcript-search"
    >
      <style>{STYLE}</style>
      <SearchIcon size={12} className="text-text-faint shrink-0" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in transcript"
        aria-label="Find in transcript"
        spellCheck={false}
        className="text-body text-text-strong placeholder:text-text-faint h-6 min-w-0 flex-1 bg-transparent outline-none"
        data-testid="transcript-search-input"
      />
      <span
        className="text-caption text-text-subtle tabular shrink-0 px-1"
        aria-live="polite"
        data-testid="transcript-search-count"
      >
        {countLabel(deferred, hits.length, Math.min(index, hits.length - 1))}
      </span>
      <IconButton
        label={`Match case (${shortcutLabel(FIELD_CHORDS.matchCase)})`}
        pressed={matchCase}
        onClick={() => setMatchCase((v) => !v)}
      >
        <span className="font-mono text-[12px]">Aa</span>
      </IconButton>
      <IconButton
        label={`Previous match (${shortcutLabel(FIELD_CHORDS.previousMatch)})`}
        disabled={hits.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon size={10} />
      </IconButton>
      <IconButton label="Next match (↵)" disabled={hits.length === 0} onClick={() => step(1)}>
        <ChevronDownIcon size={10} />
      </IconButton>
      <IconButton label="Close (esc)" onClick={onClose}>
        <CloseIcon size={10} />
      </IconButton>
    </div>
  );
};
