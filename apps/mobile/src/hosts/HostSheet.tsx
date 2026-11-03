/**
 * The host details sheet (Paper MX-AE): Connection State and how long, the last failure, round
 * trip, route, agent sessions, this iPhone's notification switch, and Unlink for relay Hosts.
 */
import { mobileFont, mobileType } from "@polaris/ui/tokens";
import { PolarisPush } from "../../modules/polaris-push/index.ts";
import { Alert, Platform, Pressable, Switch, Text, View } from "react-native";
import { openAndroidNotificationSettings } from "../notifications/android.ts";
import { DEVICE_COPY } from "../app/platformCopy.ts";
import {
  constellationNotifications,
  useConstellationNotifications,
} from "../push/constellations.ts";
import { InstrumentSheet, SheetHeader, Well } from "../sheet/index.tsx";
import { themedStyles, useTheme } from "../theme/index.ts";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { shortHostName } from "../home/model/format.ts";
import type { HostDetails } from "./model.ts";
import { StateDot, stateLineColour } from "./StateDot.tsx";

const Readout = ({
  label,
  value,
  mono,
  faint = false,
  last = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly faint?: boolean;
  readonly last?: boolean;
}) => {
  const styles = useStyles();

  return (
    <View style={[styles.readout, last ? null : styles.divided]} accessible>
      <Text style={styles.label} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
        {label}
      </Text>
      <Text
        style={[mono ? styles.monoValue : styles.value, faint ? styles.faint : null]}
        maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
      >
        {value}
      </Text>
    </View>
  );
};

/** The device-wide switch (Paper M9), said honestly: no Host has a switch of its own yet. */
const Notifications = () => {
  const styles = useStyles();
  const { colours } = useTheme();
  const on = useConstellationNotifications();

  if (Platform.OS === "android")
    return (
      <Pressable accessibilityRole="button" onPress={() => void openAndroidNotificationSettings()}>
        <Well style={styles.switchWell}>
          <View style={styles.switchText}>
            <Text style={styles.switchTitle} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
              Live updates
            </Text>
            <Text style={styles.switchCaption} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
              On this device · In Android settings
            </Text>
          </View>
        </Well>
      </Pressable>
    );

  return (
    <Well style={styles.switchWell}>
      <View style={styles.switchText}>
        <Text style={styles.switchTitle} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          When a constellation needs you
        </Text>
        <Text style={styles.switchCaption} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          On this {DEVICE_COPY.phone}, for every host
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={constellationNotifications.set}
        accessibilityLabel="When a constellation needs you"
        trackColor={{ true: colours.textDefault, false: colours.rowSelected }}
        thumbColor={on ? colours.panel : colours.textSubtle}
        ios_backgroundColor={colours.rowSelected}
      />
    </Well>
  );
};

const confirmUnlink = (name: string, onUnlink: () => void) =>
  Alert.alert(
    `Unlink this ${DEVICE_COPY.phone} from ${name}?`,
    `${name} forgets this ${DEVICE_COPY.phone}, and its agent sessions leave this list. Your other hosts stay linked; link again from your ${DEVICE_COPY.computer}.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Unlink", style: "destructive", onPress: onUnlink },
    ]
  );

export const HostSheet = ({
  details,
  onClose,
  onUnlink,
}: {
  /** The Host on show; null closes the sheet (as when it was unlinked). */
  readonly details: HostDetails | null;
  readonly onClose: () => void;
  /** Present only for a Host linked through the Polaris Relay. */
  readonly onUnlink: (() => void) | null;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <InstrumentSheet open={details !== null} onClose={onClose}>
      {details === null ? null : (
        <>
          <SheetHeader title={details.name} titleLines={2} onClose={onClose} />
          <View style={styles.status} accessible>
            <StateDot state={details.state} />
            <Text
              style={[styles.statusText, { color: stateLineColour(details.state, colours) }]}
              maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            >
              {details.status}
            </Text>
          </View>
          {details.failure === null ? null : (
            <Well style={styles.failure}>
              <Text style={styles.kicker} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
                LAST FAILURE
              </Text>
              <Text style={styles.failureText} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
                {details.failure}
              </Text>
            </Well>
          )}
          <Well style={styles.readouts}>
            <Readout
              label="Round trip"
              value={details.roundTrip}
              mono
              faint={details.state !== "connected"}
            />
            <Readout label="Route" value={details.route} mono={false} />
            <Readout label={details.sessionsLabel} value={details.sessions} mono last />
          </Well>
          {onUnlink === null ? null : (
            <>
              {Platform.OS === "android" || PolarisPush !== null ? <Notifications /> : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => confirmUnlink(details.name, onUnlink)}
                style={({ pressed }) => [styles.unlink, pressed ? styles.pressed : null]}
              >
                <Text
                  style={styles.unlinkText}
                  numberOfLines={2}
                  maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
                >
                  Unlink this {DEVICE_COPY.phone} from {shortHostName(details.name)}…
                </Text>
              </Pressable>
            </>
          )}
        </>
      )}
    </InstrumentSheet>
  );
};

const useStyles = themedStyles((colours) => ({
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6 },
  statusText: { ...mobileType.callout, lineHeight: 20, flexShrink: 1 },
  failure: { gap: 4 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "500",
    letterSpacing: 0.8,
    color: colours.textFaint,
  },
  failureText: {
    fontFamily: mobileFont.mono,
    fontSize: 12,
    lineHeight: 18,
    color: colours.textDefault,
  },
  readouts: { paddingVertical: 0, paddingHorizontal: 0, gap: 0 },
  readout: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  divided: { borderBottomWidth: 1, borderBottomColor: colours.hairline },
  label: { ...mobileType.callout, lineHeight: 20, color: colours.textSubtle },
  value: { ...mobileType.callout, lineHeight: 20, color: colours.textDefault, flexShrink: 1 },
  monoValue: {
    fontFamily: mobileFont.mono,
    fontSize: 14,
    lineHeight: 20,
    color: colours.textDefault,
    fontVariant: ["tabular-nums"],
  },
  faint: { color: colours.textFaint },
  switchWell: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchText: { flex: 1, minWidth: 0 },
  switchTitle: { ...mobileType.callout, lineHeight: 20, color: colours.textDefault },
  switchCaption: { ...mobileType.footnote, fontSize: 12, lineHeight: 16, color: colours.textFaint },
  unlink: {
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.raised,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  pressed: { transform: [{ scale: 0.98 }] },
  unlinkText: {
    ...mobileType.heading,
    fontWeight: "600",
    color: colours.failedText,
    textAlign: "center",
  },
}));
