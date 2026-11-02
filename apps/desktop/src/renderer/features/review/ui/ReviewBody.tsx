/**
 * A subject's two panels (Paper X-G): the header, tabs and diff (or what stands in for the
 * diff while it loads, fails or waits for a Review Checkout), and the risk panel (the Risk
 * Summary slot and its foot slot). The file list goes under the queue (`filesSlot.tsx`).
 */
import { cn, EmptyState, Panel, PixelForkIcon, SegmentedControl } from "@polaris/ui";
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { type ReactNode, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { ReviewDiff } from "../data/useReviewDiff.ts";
import { paneState } from "../model/paneState.ts";
import { scaleNotice } from "../model/policy.ts";
import { quoteLines } from "../model/quote.ts";
import {
  type DiffSelection,
  emptySurface,
  type ReviewSlotProps,
  reviewSlots,
  surfaceStore,
  updateSurface,
} from "../surface.ts";
import {
  type EditorPlace,
  EditorPlaceProvider,
  usePublishReviewPlace,
} from "../../editor-links/index.ts";
import { CentrePane, setTab, type SessionInfo } from "../overview/index.ts";
import { DiffPane } from "./DiffPane.tsx";
import { setTestsHidden } from "../data/testsStore.ts";
import {
  setListGrouping,
  setSessionGrouping,
  useListGrouping,
  useSessionGrouping,
} from "../data/groupingStore.ts";
import type { Grouping } from "../model/groups.ts";
import { useRisk } from "../../risk/data/riskStore.ts";
import { FileList } from "./FileList.tsx";
import { InFilesSlot } from "./filesSlot.tsx";
import { useThemeType } from "../../diffs/index.ts";
import { type PullViewed, useReviewModel } from "./useReviewModel.ts";
import { SchemaDiffBody } from "../schema/SchemaDiffBody.tsx";
import { type ReviewSchema, useSchemaSection } from "../schema/section.ts";
import { TracesCompareBody } from "../traces/TracesCompareBody.tsx";
import { useTracesSection } from "../traces/section.ts";
import type { ReviewTraces } from "../traces/useReviewTraces.ts";

export interface Placeholder {
  readonly title: string;
  readonly fact: string;
  readonly action?: ReactNode;
}

export interface ReviewBodyProps {
  readonly subjectKey: string;
  readonly slotProps: ReviewSlotProps;
  readonly diff: ReviewDiff;
  readonly pullViewed: PullViewed | null;
  /** Shown instead of the diff (no checkout yet, a failure); null while loading or ready. */
  readonly placeholder: Placeholder | null;
  /** An Agent Session's Overview; null for a pull request. */
  readonly session: SessionInfo | null;
  /** The checkout's merge base, for narrowing Changes to the first commit. */
  readonly mergeBase: string | null;
  /** Where the diff's paths are on disk (the Review Checkout, the session's cwd), for "Open in editor". */
  readonly place: EditorPlace | null;
  /** The subject's header, at the top of the diff's panel. */
  readonly header: ReactNode;
  /** An Agent Session's Schema Diff (ENG-645); null for a pull request or without one. */
  readonly schema: ReviewSchema | null;
  /** An Agent Session's route timings (ENG-660); null for a pull request or without them. */
  readonly traces: ReviewTraces | null;
}

/** The right panel: the Risk Summary card and its foot (the Reviewer's composer). */
const RiskPanel = ({ slotProps }: { readonly slotProps: ReviewSlotProps }) => {
  const { RiskColumn: Risk, RiskFooter: Footer } = reviewSlots.current;

  return (
    <Panel asChild className="mb-2 w-[360px] shrink-0">
      <aside data-testid="risk-column">
        <Risk {...slotProps} />
        <Footer {...slotProps} />
      </aside>
    </Panel>
  );
};

/** The centre panel: the header over the tabs and the diff, the calmest surface. */
const DiffPanel = ({
  header,
  children,
}: {
  readonly header: ReactNode;
  readonly children: ReactNode;
}) => (
  <Panel asChild className="mb-2 min-w-0 flex-1">
    <div data-testid="review-centre-panel">
      {header}
      {children}
    </div>
  </Panel>
);

const selectionOf = (
  path: string,
  range: SelectedLineRange,
  item: { readonly fileDiff: FileDiffMetadata } | null,
  turn: number | null
): DiffSelection => {
  const side = range.side === "deletions" ? "old" : "new";
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const code = item === null ? "" : quoteLines(item.fileDiff, side, start, end);

  return { path, side, start, end, code, turn };
};

const Waiting = ({ placeholder }: { readonly placeholder: Placeholder | null }) => (
  <div className="flex min-w-0 flex-1 items-center justify-center" data-testid="review-waiting">
    {placeholder === null ? (
      <span className="text-caption text-text-subtle">Reading the diff…</span>
    ) : (
      <EmptyState icon={<PixelForkIcon size={24} />} {...placeholder} />
    )}
  </div>
);

const SESSION_MODES = [
  { value: "turn", label: "By turn" },
  { value: "intent", label: "By intent" },
] as const;

const groupingCaption = (grouping: Grouping) => {
  if (grouping.source === "path") return "Grouped by path · write a walkthrough to group by intent";
  const count = grouping.groups.length;

  return `${count.toLocaleString("en-US")} ${count === 1 ? "intent" : "intents"} · from the walkthrough`;
};

/** An Agent Session's "By turn / By intent" over the diff (Paper R11b), remembered per Mac. */
const SessionGroupingBar = ({ grouping }: { readonly grouping: Grouping }) => {
  const mode = useSessionGrouping();

  return (
    <div className="px-panel pt-panel gap-row-x flex shrink-0 items-center" data-testid="review-by">
      <SegmentedControl
        aria-label="Group the diff"
        variant="well"
        options={SESSION_MODES}
        value={mode}
        onValueChange={setSessionGrouping}
      />
      {mode === "intent" && (
        <span className="text-caption text-text-subtle truncate">{groupingCaption(grouping)}</span>
      )}
    </div>
  );
};

const Ready = ({
  subjectKey,
  slotProps,
  diff,
  pullViewed,
  session,
  mergeBase,
  header,
  schema,
  traces,
}: ReviewBodyProps & { readonly diff: Extract<ReviewDiff, { readonly kind: "ready" }> }) => {
  const section = useSchemaSection(subjectKey, schema);
  const timings = useTracesSection(subjectKey, traces);
  // A Schema Diff or Route timings stands in for the diff until a file is opened.
  const replaced = section.shown !== null || timings.shown;
  const surface = useStore(surfaceStore, (s) => s[subjectKey] ?? emptySurface);
  const themeType = useThemeType();
  const risk = useRisk(subjectKey);
  const listMode = useListGrouping();
  const sessionMode = useSessionGrouping();

  const model = useReviewModel({
    subjectKey,
    diff,
    findings: surface.findings,
    annotations: surface.annotations,
    selection: surface.selection,
    pullViewed,
    intents: risk.kind === "ready" ? risk.summary.walkthrough?.groups : undefined,
    byIntent: session !== null && sessionMode === "intent",
  });

  const pane = paneState({
    files: model.files.length,
    items: model.items.length,
    complete: diff.complete,
    scale: diff.scale,
  });

  const paths = useMemo(() => model.files.map((f) => f.file.path), [model.files]);

  useEffect(() => {
    updateSurface(subjectKey, { paths });
  }, [subjectKey, paths]);

  useEffect(() => {
    const diffs = new Map(
      model.items.flatMap((p) =>
        p.item.type === "diff" ? [[p.path, p.item.fileDiff] as const] : []
      )
    );

    updateSurface(subjectKey, {
      quote: (range) => {
        const fileDiff = diffs.get(range.path);

        return fileDiff === undefined
          ? ""
          : quoteLines(fileDiff, range.side, range.start, range.end);
      },
    });
  }, [subjectKey, model.items]);

  return (
    <>
      <InFilesSlot>
        <FileList
          files={model.files}
          viewedOf={model.viewedOf}
          changedOf={(file) => model.viewedStateOf(file) === "changed"}
          severities={model.severities}
          progress={model.progress}
          current={model.openFile}
          notice={scaleNotice(diff.scale, model.files.length)}
          onOpen={(file) => {
            setTab(subjectKey, "changes");
            section.closeSchema();
            timings.closeTraces();
            model.open(file);
          }}
          onViewed={model.setViewed}
          tests={model.tests}
          onTestsHidden={setTestsHidden}
          grouping={model.grouping}
          mode={listMode}
          onMode={setListGrouping}
          data={section.data}
          traces={timings.list}
        />
      </InFilesSlot>
      <DiffPanel header={header}>
        <CentrePane
          subjectKey={subjectKey}
          slotProps={slotProps}
          files={model.files.length}
          viewed={model.progress.viewed}
          session={session}
          mergeBase={mergeBase}
          changes={
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              data-testid="review-diff"
              data-complete={diff.complete ? "" : undefined}
              data-files={model.files.length}
            >
              {session !== null && pane.kind !== "message" && !replaced && (
                <SessionGroupingBar grouping={model.grouping} />
              )}
              {section.shown !== null && schema !== null && (
                <SchemaDiffBody
                  source={section.shown}
                  scope={schema.scope}
                  turn={schema.turn}
                  turnNumber={schema.turnNumber}
                  pruned={schema.pruned?.text ?? null}
                  onOpenTable={(table) =>
                    section.shown === null ? undefined : schema.onOpenTable(section.shown, table)
                  }
                />
              )}
              {timings.shown && traces !== null && (
                <TracesCompareBody
                  answer={traces.answer}
                  plan={traces.plan}
                  onOpenRoute={traces.onOpenRoute}
                />
              )}
              {pane.kind === "message" ? (
                !replaced && <Waiting placeholder={{ title: pane.title, fact: pane.fact }} />
              ) : (
                <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", replaced && "hidden")}>
                  <DiffPane
                    items={model.items}
                    marksCss={model.marksCss}
                    themeType={themeType}
                    loadDiffFiles={model.loadDiffFiles}
                    itemKeys={model.itemKeys}
                    subjectKey={subjectKey}
                    onSelect={(id, range) => {
                      const file = model.files.find((f) => f.key === id);
                      const parsed = model.items.find((p) => p.item.id === id)?.item;

                      updateSurface(subjectKey, {
                        selection:
                          file === undefined || range === null
                            ? null
                            : selectionOf(
                                file.file.path,
                                range,
                                parsed?.type === "diff" ? parsed : null,
                                diff.sections.find((s) => s.id === file.section)?.divider?.turn ??
                                  null
                              ),
                      });
                    }}
                  />
                </div>
              )}
            </div>
          }
        />
      </DiffPanel>
      <RiskPanel slotProps={slotProps} />
    </>
  );
};

const Body = (props: ReviewBodyProps) => {
  if (props.diff.kind === "ready") return <Ready {...props} diff={props.diff} />;

  const failed: Placeholder | null =
    props.diff.kind === "failed"
      ? { title: "Couldn’t read the diff", fact: props.diff.error.message }
      : null;

  return (
    <>
      <DiffPanel header={props.header}>
        <CentrePane
          subjectKey={props.subjectKey}
          slotProps={props.slotProps}
          files={null}
          viewed={null}
          session={props.session}
          mergeBase={props.mergeBase}
          changes={<Waiting placeholder={props.placeholder ?? failed} />}
        />
      </DiffPanel>
      <RiskPanel slotProps={props.slotProps} />
    </>
  );
};

export const ReviewBody = (props: ReviewBodyProps) => {
  usePublishReviewPlace(props.place);

  return (
    <EditorPlaceProvider value={props.place}>
      <Body {...props} />
    </EditorPlaceProvider>
  );
};
