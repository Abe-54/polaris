/**
 * Home with nothing to list: no Host yet and none reachable as MX-AV's raised horizon
 * (`StatePanel`); the first snapshot on its way, no agent sessions, or none in a workspace as
 * MX-C's wells on the ground.
 */
import { mobileType } from "@polaris/ui/tokens";
import { Match } from "effect";
import { Pressable, Text, View } from "react-native";
import { themedStyles } from "../../theme/index.ts";
import { StatePanel } from "../../states/StatePanel.tsx";
import type { HomeEmpty, Unreachable } from "../model/home.ts";
import { DEVICE_COPY } from "../../app/platformCopy.ts";

interface Copy {
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
}

const useStyles = themedStyles((c) => ({
  // Home's list pads its rows by 10; the raised horizon spans the screen.
  bleed: { marginHorizontal: -10 },
  empty: {
    marginHorizontal: 10,
    paddingVertical: 20,
    paddingHorizontal: 18,
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.well,
  },
  title: { ...mobileType.title, color: c.textStrong },
  body: { ...mobileType.callout, color: c.textSubtle, maxWidth: 320 },
  action: {
    alignSelf: "flex-start",
    marginTop: 8,
    height: 36,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.raised,
    justifyContent: "center",
  },
  actionLabel: { ...mobileType.label, color: c.textDefault },
  loading: { marginHorizontal: 10, gap: 6 },
  ghost: {
    height: 70,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.well,
  },
}));

/** Quiet wells where rows will land; nothing moves, as only Working loops. */
const Loading = ({ styles }: { readonly styles: ReturnType<typeof useStyles> }) => (
  <View
    style={styles.loading}
    accessible
    accessibilityRole="progressbar"
    accessibilityLabel="Loading agent sessions"
  >
    {[1, 0.6, 0.3].map((opacity) => (
      <View key={opacity} style={[styles.ghost, { opacity }]} />
    ))}
  </View>
);

/** Home's empties that raise the horizon (MX-AV): the screen drops its own foot horizon for them. */
export const raisesHorizon = (empty: HomeEmpty | null) =>
  empty === "no-hosts" || empty === "unreachable";

const UNREACHABLE_LINE = "Their agent sessions appear here as soon as one connects.";

/**
 * "Can't reach your hosts" (MX-AV): a Host's own failure in mono, else `line`; an amber
 * Reconnecting while Polaris still tries; See hosts.
 */
export const UnreachablePanel = ({
  unreachable,
  line,
  onHosts,
}: {
  readonly unreachable: Unreachable;
  readonly line: string;
  readonly onHosts: () => void;
}) => {
  const title = "Can't reach your hosts";
  const action = { label: "See hosts", onPress: onHosts };

  const panel =
    unreachable.failure === null
      ? { title, action, line }
      : { title, action, failure: unreachable.failure };

  if (!unreachable.reconnecting) return <StatePanel {...panel} />;

  return <StatePanel {...panel} reconnecting="Polaris keeps trying" />;
};

export const EmptyHome = ({
  empty,
  unreachable,
  workspace,
  onLink,
  onHosts,
  onAll,
}: {
  readonly empty: HomeEmpty;
  readonly unreachable: Unreachable;
  readonly workspace: string | null;
  readonly onLink: () => void;
  readonly onHosts: () => void;
  readonly onAll: () => void;
}) => {
  const styles = useStyles();

  if (empty === "no-hosts")
    return (
      <View style={styles.bleed}>
        <StatePanel
          title="No hosts yet"
          line={`Link this ${DEVICE_COPY.phone} from Polaris on your ${DEVICE_COPY.computer}. Its hosts and their agent sessions appear here.`}
          action={{ label: `Link this ${DEVICE_COPY.phone}`, onPress: onLink, primary: true }}
        />
      </View>
    );

  if (empty === "unreachable")
    return (
      <View style={styles.bleed}>
        <UnreachablePanel unreachable={unreachable} line={UNREACHABLE_LINE} onHosts={onHosts} />
      </View>
    );

  const copy = Match.value(empty).pipe(
    Match.when("loading", () => null),
    Match.when("no-sessions", (): Copy => ({
      title: "No agent sessions yet",
      body: `Start one with New, or from Polaris on your ${DEVICE_COPY.computer}.`,
      action: null,
    })),
    Match.when("filtered", (): Copy => ({
      title: `Nothing in ${workspace ?? "this workspace"}`,
      body: "No agent sessions in this workspace right now.",
      action: { label: "All workspaces", run: onAll },
    })),
    Match.exhaustive
  );

  if (copy === null) return <Loading styles={styles} />;

  return (
    <View style={styles.empty}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      {copy.action === null ? null : (
        <Pressable accessibilityRole="button" onPress={copy.action.run} style={styles.action}>
          <Text style={styles.actionLabel}>{copy.action.label}</Text>
        </Pressable>
      )}
    </View>
  );
};
