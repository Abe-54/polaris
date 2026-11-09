/**
 * MX-N's findings, most severe first: open ones as wells with their hunk, folded ones as rows
 * grouped into one well per run. Each reports where it sits, so the pager can scroll to it.
 */
import type { RiskFinding } from "@polaris/protocol";
import { type LayoutChangeEvent, View } from "react-native";
import type { DiffFileInput } from "../diffRows.ts";
import { findingHunk } from "../FindingCard/hunk.ts";
import { FindingWell, FoldedFinding, type WellActions } from "../FindingCard/Well.tsx";
import type { DiffPalette } from "../palette.ts";

export interface FindingsProps {
  /** Listed findings in Review's order. */
  readonly findings: ReadonlyArray<RiskFinding>;
  readonly files: ReadonlyArray<DiffFileInput>;
  readonly expanded: ReadonlySet<string>;
  readonly palette: DiffPalette;
  readonly actions: WellActions;
  readonly onExpand: (id: string) => void;
  /** A finding's top in the scroll content. */
  readonly onPlace: (id: string, y: number) => void;
}

/** An open Critical never folds; a dismissed one folds with its note (DESIGN.md Review). */
export const isOpen = (finding: RiskFinding, expanded: ReadonlySet<string>) =>
  (finding.severity === "critical" && finding.status === "open") || expanded.has(finding.id);

const GAP = 6;

export const Findings = (props: FindingsProps) => {
  const { findings, expanded } = props;

  return (
    <>
      {findings.map((finding, i) => {
        const open = isOpen(finding, expanded);
        const before = findings[i - 1];
        const after = findings[i + 1];
        const first = before === undefined || isOpen(before, expanded);
        const last = after === undefined || isOpen(after, expanded);

        const place = ({ nativeEvent }: LayoutChangeEvent) =>
          props.onPlace(finding.id, nativeEvent.layout.y);

        return (
          <View key={finding.id} onLayout={place} style={{ marginTop: open || first ? GAP : 0 }}>
            {open ? (
              <FindingWell
                finding={finding}
                hunk={findingHunk(props.files, finding)}
                palette={props.palette}
                actions={props.actions}
              />
            ) : (
              <FoldedFinding finding={finding} first={first} last={last} onOpen={props.onExpand} />
            )}
          </View>
        );
      })}
    </>
  );
};
