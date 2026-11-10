/**
 * The rail list's rows (Paper C2): group headers that fold once finished, and task rows with
 * a glyph, a mono id, the title and state word, then a second line or the handed-up claim.
 */
import { mobileType } from "@polaris/ui/tokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { HandedClaimActions, Checks, type SendVerdict } from "./claim.tsx";
import type { Delivery } from "./outbox.ts";
import type { Unsent } from "./unsent.ts";
import { type MobileColours, themedStyles, useTheme } from "../theme/index.ts";
import { GateDeps, GroupGlyph, TaskGlyph } from "./glyphs.tsx";
import type { GroupRow, SecondLine, TaskRow, Tone } from "./model.ts";

/** DESIGN.md, Rail glyphs: rail lines are white at ~14%. */
const RAIL = "#ffffff24";

const idColour = (colours: MobileColours, tone: Tone): string => {
  const byTone: Readonly<Record<Tone, string>> = {
    "needs-you": colours.needsYouText,
    done: colours.acceptedText,
    failed: colours.failedText,
    waiting: colours.textFaint,
    ended: colours.textFaint,
    working: colours.textSubtle,
    review: colours.textSubtle,
    blocked: colours.textSubtle,
  };

  return byTone[tone];
};

const wordColour = (colours: MobileColours, tone: Tone): string => {
  if (tone === "needs-you") return colours.needsYouText;

  if (tone === "done") return colours.acceptedText;

  if (tone === "failed") return colours.failedText;

  return tone === "waiting" || tone === "ended" ? colours.textFaint : colours.textSubtle;
};

/** DESIGN.md, Tree: id and title indent per level (ENG-690); past three levels they stay put. */
const NEST_STEP = 16;

const NEST_MAX = 3;

const quiet = (tone: Tone) => tone === "waiting" || tone === "ended";

/** "1 needs you · 1 working", or "3 done · show" for a finished group. */
const GroupCounts = ({ group }: { readonly group: GroupRow }) => {
  const styles = useStyles();
  const { colours } = useTheme();

  if (group.finished)
    return (
      <Text style={styles.groupCount}>
        {group.done} done · {group.open ? "hide" : "show"}
      </Text>
    );

  const parts = [
    group.working > 0 ? `${group.working} working` : null,
    group.review > 0 ? `${group.review} in review` : null,
    `${group.done} of ${group.total} done`,
  ].filter((p) => p !== null);

  return (
    <Text style={[styles.groupCount, { color: colours.textSubtle }]}>
      {group.needsYou > 0 ? (
        <Text style={{ color: colours.needsYouText }}>{group.needsYou} needs you · </Text>
      ) : null}
      {parts.join(" · ")}
    </Text>
  );
};

export const GroupHeader = ({
  group,
  onToggle,
}: {
  readonly group: GroupRow;
  readonly onToggle: () => void;
}) => {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: group.open }}
      style={styles.group}
      onPress={onToggle}
    >
      <View style={styles.rail} />
      <GroupGlyph finished={group.finished} />
      <Text style={styles.groupName} numberOfLines={1}>
        {group.name}
      </Text>
      <GroupCounts group={group} />
    </Pressable>
  );
};

const Second = ({
  second,
  worker,
}: {
  readonly second: SecondLine | null;
  readonly worker: string | null;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();

  if (second === null) return worker === null ? null : <Text style={styles.faint}>{worker}</Text>;

  if (second.kind === "activity")
    return (
      <Text style={styles.command} numberOfLines={1}>
        {second.command} · {second.elapsed}
        {worker === null ? null : <Text style={styles.faint}>{`  ${worker}`}</Text>}
      </Text>
    );

  if (second.kind === "claim")
    return (
      <View style={styles.claimLine}>
        <Checks head={second.head} checks={second.checks} />
      </View>
    );

  if (second.kind === "after")
    return (
      <Text style={styles.faint}>
        after <Text style={{ color: colours.textSubtle }}>{second.ids}</Text>
      </Text>
    );

  return (
    <Text style={styles.faint} numberOfLines={2}>
      {second.text}
    </Text>
  );
};

/** "← M, X": its deps other than the row it hangs under, each id in its state's tone. */
const Also = ({ deps }: { readonly deps: TaskRow["also"] }) => {
  const styles = useStyles();
  const { colours } = useTheme();

  if (deps.length === 0) return null;

  return (
    <Text style={styles.also} accessibilityLabel={`also after ${deps.map((d) => d.id).join(", ")}`}>
      {"  ← "}
      {deps.map((dep, n) => (
        <Text key={dep.id}>
          {n === 0 ? "" : ", "}
          <Text style={[styles.alsoId, { color: idColour(colours, dep.tone) }]}>{dep.id}</Text>
        </Text>
      ))}
    </Text>
  );
};

export const TaskRowView = ({
  row,
  first,
  last,
  delivery,
  onVerdict,
  onCancel,
  unsent,
  onUnsent,
  onPress,
}: {
  readonly row: TaskRow;
  readonly first: boolean;
  readonly last: boolean;
  /** The verdict on its way for this task, if any. */
  readonly delivery: Delivery | null;
  readonly onVerdict: SendVerdict;
  readonly onCancel: () => void;
  /** The claim's unsent choice and answer, kept by the caller (see `HandedClaimActions`). */
  readonly unsent: Unsent | null;
  readonly onUnsent: (next: Unsent) => void;
  /** Opens the task (its task sheet) from its title line. */
  readonly onPress?: () => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <View style={[styles.task, !first && styles.divided]}>
      <View style={[styles.rail, last && styles.railEnd]} />
      <TaskGlyph tone={row.tone} harness={row.harness} gate={row.gate} />
      {row.depth === 0 ? null : (
        <View style={{ width: Math.min(row.depth, NEST_MAX) * NEST_STEP - 12 }} />
      )}
      <Text style={[styles.id, { color: idColour(colours, row.tone) }]}>{row.id}</Text>
      <View style={styles.body}>
        <Pressable
          accessibilityRole={onPress === undefined ? undefined : "button"}
          disabled={onPress === undefined}
          onPress={onPress}
          style={styles.titleLine}
        >
          {row.gate && row.deps.length > 0 ? <GateDeps deps={row.deps} /> : null}
          <Text
            style={[styles.title, quiet(row.tone) && { color: colours.textDefault }]}
            numberOfLines={2}
          >
            {row.title}
            <Also deps={row.also} />
          </Text>
          <Text style={[styles.word, { color: wordColour(colours, row.tone) }]}>{row.word}</Text>
        </Pressable>
        {row.handed === null && delivery === null ? (
          <Second second={row.second} worker={row.worker} />
        ) : (
          <HandedClaimActions
            claim={row.handed}
            delivery={delivery}
            onVerdict={onVerdict}
            onCancel={onCancel}
            unsent={unsent}
            onUnsent={onUnsent}
          />
        )}
      </View>
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  rail: {
    position: "absolute",
    left: 7.25,
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: RAIL,
  },
  railEnd: { bottom: "50%" },
  group: { flexDirection: "row", alignItems: "center", gap: 12, height: 36 },
  groupName: { ...mobileType.footnote, flex: 1, color: colours.textSubtle },
  groupCount: { ...mobileType.footnote, color: colours.textDefault },
  task: { flexDirection: "row", gap: 12, paddingVertical: 12 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colours.hairline },
  id: { ...mobileType.index, fontSize: 13, lineHeight: 20, width: 26 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { ...mobileType.heading, flex: 1, color: colours.textStrong },
  word: { ...mobileType.footnote },
  command: { ...mobileType.index, color: colours.textSubtle },
  faint: { ...mobileType.footnote, color: colours.textFaint },
  also: { ...mobileType.footnote, color: colours.textFaint },
  alsoId: { ...mobileType.index, fontSize: 12 },
  claimLine: { paddingTop: 2 },
}));
