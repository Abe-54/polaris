/**
 * A Review that can't open yet (ENG-582): quiet wells while the session loads, else the states
 * pattern (MX-AV) naming the Host, Reconnecting or Offline, or why the Turn can't be found.
 */
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type StateAction, StatePanel } from "../../states/StatePanel.tsx";
import { themedStyles } from "../../theme/index.ts";
import { BackButton } from "../ReviewView/Back.tsx";
import type { ReviewGate } from "./gate.ts";

/** What an away Host's panel says beyond its line or failure. */
interface AwayPanel {
  title: string;
  action?: StateAction;
  reconnecting?: string;
}

type Closed = Exclude<ReviewGate, { readonly kind: "ready" }>;

const Panel = ({ gate, onRetry }: { readonly gate: Closed; readonly onRetry: () => void }) => {
  const styles = useStyles();

  if (gate.kind === "loading")
    return (
      <View
        style={styles.loading}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading the review"
      >
        {[1, 0.6, 0.3].map((opacity) => (
          <View key={opacity} style={[styles.ghost, { opacity }]} />
        ))}
      </View>
    );

  if (gate.kind === "missing")
    return gate.failure === null ? (
      <StatePanel title={gate.title} />
    ) : (
      <StatePanel title={gate.title} failure={gate.failure} />
    );

  const panel: AwayPanel = { title: gate.title };

  if (gate.retry) panel.action = { label: "Retry now", onPress: onRetry };

  if (gate.reconnecting) panel.reconnecting = "Polaris keeps trying";

  return gate.failure === null ? (
    <StatePanel {...panel} line={gate.line} />
  ) : (
    <StatePanel {...panel} failure={gate.failure} />
  );
};

export const ReviewGateScreen = ({
  gate,
  onBack,
  onRetry,
}: {
  readonly gate: Closed;
  readonly onBack?: (() => void) | undefined;
  readonly onRetry: () => void;
}) => {
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        {onBack === undefined ? null : <BackButton onPress={onBack} />}
      </View>
      <Panel gate={gate} onRetry={onRetry} />
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1, backgroundColor: colours.ground },
  header: { minHeight: 56, paddingTop: 4, paddingBottom: 12, paddingHorizontal: 16 },
  loading: { marginHorizontal: 10, gap: 6 },
  ghost: {
    height: 70,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
  },
}));
