/**
 * Link this iPhone (DESIGN.md, Mobile chrome redesign · phase 3; Paper MX-AH to MX-AM): the sky and
 * the Polaris star over the scan sheet. The star stays in place; only its light follows the link.
 */
import type { LinkedHost } from "@polaris/client/relay";
import { mobileType } from "@polaris/ui/tokens";
import { useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEVICE_COPY } from "../app/platformCopy.ts";
import { HORIZON_HEIGHT } from "../horizon/index.tsx";
import { RIDGE_TOP } from "../horizon/scene.ts";
import { useRelay } from "../relay/RelayProvider.tsx";
import { CHROME_TEXT_SCALE } from "../theme/textScale.ts";
import { themedStyles } from "../theme/index.ts";
import { HEADING_TOP_MIN, headingTop, scanSheetHeight, starLight } from "./model.ts";
import { type LinkingState, PAIRING_COPY, ScanSheetView, useLinking } from "./ScanSheet.tsx";
import { Sky } from "./Sky.tsx";
import { STAR_SIZE } from "./Star.tsx";

/** MX-AH: the star rests at most 300pt down and clear of the scan step's ridge by 24pt. */
const STAR_LOWEST = 300;

const RIDGE_GAP = 24;

const HEADING_GAP = 20;

/** One place for the star in every step: between the heading and the scan step's ridge. */
const starTopFor = (height: number, headingBottom: number, titled: boolean): number => {
  const ridge = height - scanSheetHeight({ kind: "scan" }, titled) - HORIZON_HEIGHT + RIDGE_TOP;

  return Math.round(
    Math.max(headingBottom + HEADING_GAP, Math.min(STAR_LOWEST, ridge - STAR_SIZE - RIDGE_GAP))
  );
};

export interface PairingProps {
  readonly linking: LinkingState;
  /** Absent on first run: there is nothing to go back to. */
  readonly onCancel?: (() => void) | undefined;
}

/** The screen drawn from a linking state; `LinkScreen` links through the Polaris Relay. */
export const Pairing = ({ linking, onCancel }: PairingProps) => {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [heading, setHeading] = useState(0);
  const titled = onCancel !== undefined;
  const { step } = linking;
  const [lift, setLift] = useState(() => scanSheetHeight(step, titled));
  // At large Dynamic Type the gap above the heading gives way, then the heading scrolls.
  const room = height - lift - insets.top;
  const top = headingTop(room, heading);
  const headingBottom = insets.top + top + heading;

  return (
    <View style={styles.screen}>
      <Sky
        light={starLight(step)}
        starTop={starTopFor(height, headingBottom, titled)}
        lift={lift}
        hosts={step.kind === "linked" ? step.hosts : undefined}
      />
      <ScrollView
        style={{ maxHeight: height - lift }}
        contentContainerStyle={{ paddingTop: insets.top + top, paddingBottom: HEADING_TOP_MIN }}
        scrollEnabled={headingBottom + HEADING_TOP_MIN > height - lift}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
      >
        <View
          style={styles.heading}
          onLayout={({ nativeEvent }) => setHeading(nativeEvent.layout.height)}
        >
          <Text
            maxFontSizeMultiplier={CHROME_TEXT_SCALE}
            style={styles.title}
            accessibilityRole="header"
          >
            Link this {DEVICE_COPY.phone}
          </Text>
          <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.lead}>
            Your agent sessions run on your {DEVICE_COPY.computer}. Link it to follow them and
            answer from here.
          </Text>
        </View>
      </ScrollView>
      <ScanSheetView
        open
        {...PAIRING_COPY}
        onClose={onCancel}
        linking={linking}
        onHeight={setLift}
      />
    </View>
  );
};

export interface LinkScreenProps {
  /** Once "Linked this iPhone" has stood a moment: the app moves on by itself. */
  readonly onLinked: (hosts: ReadonlyArray<LinkedHost>) => void;
  readonly onCancel?: (() => void) | undefined;
}

export const LinkScreen = ({ onLinked, onCancel }: LinkScreenProps) => {
  const relay = useRelay();
  const linking = useLinking({ onLink: relay.link, onLinked });

  return <Pairing linking={linking} onCancel={onCancel} />;
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1, backgroundColor: colours.ground },
  heading: { paddingHorizontal: 32, gap: 10, alignItems: "center" },
  title: {
    ...mobileType.largeTitle,
    fontWeight: "600",
    letterSpacing: -0.34,
    color: colours.textStrong,
    textAlign: "center",
  },
  lead: {
    ...mobileType.body,
    fontSize: 16,
    lineHeight: 22,
    color: colours.textSubtle,
    textAlign: "center",
  },
}));
