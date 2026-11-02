/**
 * The scan sheet (DESIGN.md, Mobile chrome redesign · phase 3; Paper MX-AJ, MX-AU): scan the code
 * Polaris shows in Settings → Devices, or paste its link, then link once through the Polaris Relay.
 * One component for pairing and for Link another Mac.
 */
import type { LinkedHost } from "@polaris/client/relay";
import { mobileFont, mobileType } from "@polaris/ui/tokens";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Dither } from "../dither/index.ts";
import { InstrumentSheet, SheetHeader, SheetKicker } from "../sheet/index.tsx";
import { CHROME_TEXT_SCALE, CONTENT_TEXT_SCALE, CONTROL_TEXT_SCALE } from "../theme/textScale.ts";
import { themedStyles, useTheme } from "../theme/index.ts";
import { hostsLine, type LinkOutcome, type LinkStep, type Linking, linking } from "./linking.ts";
import { fittedSheetHeight } from "./model.ts";
import { Viewfinder } from "./Viewfinder.tsx";

/** The pairing sheet's copy (MX-AH, MX-AJ): the Mac is the user's own. */
export const PAIRING_COPY = {
  kicker: "Scan from your Mac",
  instruction: "On your Mac, open Polaris → Settings → Devices and scan the code.",
  pasteInstruction: "On your Mac, open Polaris → Settings → Devices and copy the link.",
} as const;

/** Link another Mac's copy (MX-AU). */
export const LINK_ANOTHER_COPY = {
  title: "Link another Mac",
  instruction: "On that Mac, open Polaris → Settings → Devices and scan the code.",
  pasteInstruction: "On that Mac, open Polaris → Settings → Devices and copy the link.",
} as const;

export interface ScanSheetCopy {
  /** The sheet's heading ("Link another Mac"); pairing leaves it out, its screen has the title. */
  readonly title?: string;
  /** The mono kicker over the viewfinder when there is no title ("Scan from your Mac", MX-AH). */
  readonly kicker?: string;
  /** Under the viewfinder: where to find the code. */
  readonly instruction: string;
  /** Over the paste field: where to copy the link. */
  readonly pasteInstruction: string;
}

export interface ScanSheetProps extends ScanSheetCopy {
  readonly open: boolean;
  /** Present when the sheet can be closed (Link another Mac); absent on first run. */
  readonly onClose?: (() => void) | undefined;
  /**
   * Links once with the scanned or pasted text and settles with the outcome; a rejection reads as
   * the Keychain refusing the keys. `useRelay().link` is one.
   */
  readonly onLink: (link: string) => Promise<LinkOutcome>;
  /** Once "Linked this iPhone" has stood a moment, with every Host the link named. */
  readonly onLinked?: ((hosts: ReadonlyArray<LinkedHost>) => void) | undefined;
}

const noop = () => undefined;

/** MX-AJ's Scan | Paste control, shown while pasting. */
const Segments = ({
  pasting,
  onSelect,
}: {
  readonly pasting: boolean;
  readonly onSelect: (kind: "scan" | "paste") => void;
}) => {
  const styles = useStyles();

  const segment = (kind: "scan" | "paste", label: string, selected: boolean) => (
    <Pressable
      key={kind}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={() => onSelect(kind)}
      style={[styles.segment, selected && styles.segmentOn]}
    >
      <Text
        maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
        style={[styles.segmentText, selected && styles.segmentTextOn]}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.segments} accessibilityRole="tablist">
      {segment("scan", "Scan", !pasting)}
      {segment("paste", "Paste", pasting)}
    </View>
  );
};

const PasteField = ({
  pasted,
  setPasted,
  onLink,
}: {
  readonly pasted: string;
  readonly setPasted: (text: string) => void;
  readonly onLink: (text: string) => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <View style={styles.pasteCard}>
      <TextInput
        style={styles.input}
        maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        value={pasted}
        onChangeText={setPasted}
        placeholder="polaris-link:…"
        placeholderTextColor={colours.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        accessibilityLabel="Link from the desktop app"
      />
      <Pressable
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
        accessibilityRole="button"
        onPress={() => onLink(pasted)}
        disabled={pasted.trim() === ""}
      >
        <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.linkText}>
          Link
        </Text>
      </Pressable>
    </View>
  );
};

const Check = () => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <View style={styles.check}>
      <Svg width={12} height={12} viewBox="0 0 12 12">
        <Path
          d="M2.5 6.2l2.4 2.4 4.6-5"
          fill="none"
          stroke={colours.panel}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
};

/** MX-AK and MX-AL: the hosts the link found, the Working dither while linking, then a check. */
const StatusRow = ({
  step,
}: {
  readonly step: Extract<LinkStep, { readonly kind: "linking" | "linked" }>;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const linked = step.kind === "linked";

  return (
    <View style={styles.status} accessible accessibilityLiveRegion="polite">
      <View style={styles.statusMark}>
        {linked ? <Check /> : <Dither color={colours.starlight} size={16} moving />}
      </View>
      <View style={styles.statusText}>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={styles.statusTitle}
          numberOfLines={1}
        >
          {hostsLine(step.hosts.length, step.hostName)}
        </Text>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.statusDetail}>
          {linked ? "Linked this iPhone" : "Linking through the Polaris Relay…"}
        </Text>
      </View>
    </View>
  );
};

/** MX-AM: the `LinkFailed` message in mono, in a well under a failed kicker. */
const FailureWell = ({ message }: { readonly message: string }) => {
  const styles = useStyles();

  return (
    <View style={styles.failure} accessible accessibilityLiveRegion="assertive">
      <View style={styles.failureHead}>
        <View style={styles.failureDot} />
        <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.failureKicker}>
          COULDN'T LINK
        </Text>
      </View>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.failureMessage}>
        {message}
      </Text>
    </View>
  );
};

const PrimaryButton = ({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) => {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
    >
      <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.primaryText}>
        {label}
      </Text>
    </Pressable>
  );
};

const WideButton = ({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) => {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.wide, pressed && styles.pressed]}
    >
      <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.wideText}>
        {label}
      </Text>
    </Pressable>
  );
};

const TextButton = ({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) => {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.textButton, pressed && styles.pressedText]}
    >
      <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.textButtonText}>
        {label}
      </Text>
    </Pressable>
  );
};

/** The scan sheet's step and its two actions; `useLinking` makes one. */
export interface LinkingState extends Linking {
  readonly step: LinkStep;
}

/** Links once with the scanned or pasted text; the step is state, so the screen can light by it. */
export const useLinking = ({
  onLink,
  onLinked,
}: Pick<ScanSheetProps, "onLink" | "onLinked">): LinkingState => {
  const [step, setStep] = useState<LinkStep>({ kind: "scan" });
  const latest = useRef({ onLink, onLinked });
  latest.current = { onLink, onLinked };

  const machine = useMemo(
    () =>
      linking({
        onLink: (link) => latest.current.onLink(link),
        onLinked: (hosts) => latest.current.onLinked?.(hosts),
        onStep: setStep,
      }),
    []
  );

  return { step, submit: machine.submit, show: machine.show };
};

const ScanStep = ({
  copy,
  titled,
  linking: { step, submit, show },
}: {
  readonly copy: ScanSheetCopy;
  readonly titled: boolean;
  readonly linking: LinkingState;
}) => {
  const styles = useStyles();

  return (
    <>
      {titled ? null : <SheetKicker parts={[copy.kicker ?? "Scan from your Mac"]} />}
      <Viewfinder scanning={step.kind === "scan"} onCode={submit} />
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.instruction}>
        {copy.instruction}
      </Text>
      <WideButton label="Paste a link instead" onPress={() => show("paste")} />
    </>
  );
};

const PasteStep = ({
  copy,
  linking: { submit, show },
  pasted,
  setPasted,
}: {
  readonly copy: ScanSheetCopy;
  readonly linking: LinkingState;
  readonly pasted: string;
  readonly setPasted: (text: string) => void;
}) => {
  const styles = useStyles();

  return (
    <>
      <Segments pasting onSelect={show} />
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.instruction}>
        {copy.pasteInstruction}
      </Text>
      <PasteField pasted={pasted} setPasted={setPasted} onLink={submit} />
    </>
  );
};

/** The sheet drawn from a linking state: the pairing screen shares its state with the sky. */
export const ScanSheetView = ({
  open,
  onClose,
  linking: state,
  onHeight,
  ...copy
}: ScanSheetCopy & {
  readonly open: boolean;
  readonly onClose?: (() => void) | undefined;
  readonly linking: LinkingState;
  /** The sheet's height whenever it changes: the pairing sky's horizon rests on it. */
  readonly onHeight?: ((height: number) => void) | undefined;
}) => {
  const { step, show } = state;
  // The pasted text survives a switch to Scan and back.
  const [pasted, setPasted] = useState("");
  const [measured, setMeasured] = useState({ kind: step.kind, height: 0 });
  const titled = copy.title !== undefined || onClose !== undefined;
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const body = measured.kind === step.kind ? measured.height : 0;
  const height = fittedSheetHeight(step, titled, body, bottom, fontScale);

  useEffect(() => {
    onHeight?.(height);
  }, [height, onHeight]);

  const content = (() => {
    switch (step.kind) {
      case "scan":
        return <ScanStep copy={copy} titled={titled} linking={state} />;
      case "paste":
        return <PasteStep copy={copy} linking={state} pasted={pasted} setPasted={setPasted} />;
      case "linking":
      case "linked":
        return <StatusRow step={step} />;
      case "failed":
        return (
          <>
            <FailureWell message={step.message} />
            <PrimaryButton label="Scan again" onPress={() => show("scan")} />
            <TextButton label="Paste a link instead" onPress={() => show("paste")} />
          </>
        );
    }
  })();

  return (
    <InstrumentSheet
      open={open}
      onClose={onClose ?? noop}
      dismissible={onClose !== undefined}
      scrim={onClose !== undefined}
      detents={[height]}
    >
      {titled ? (
        <SheetHeader title={copy.title ?? ""} {...(onClose === undefined ? {} : { onClose })} />
      ) : null}
      <View
        style={{ gap: 10 }}
        onLayout={({ nativeEvent }) =>
          setMeasured({ kind: step.kind, height: nativeEvent.layout.height })
        }
      >
        {content}
      </View>
    </InstrumentSheet>
  );
};

/**
 * Scan or paste a link and link once (MX-AJ, MX-AU): the viewfinder over the instruction and
 * "Paste a link instead", which flips to MX-AJ's Scan | Paste control, the link field and Link.
 * A failed link shows the relay's message in mono, with Scan again and Paste a link instead.
 */
export const ScanSheet = ({ open, onClose, onLink, onLinked, ...copy }: ScanSheetProps) => {
  const state = useLinking({ onLink, onLinked });

  return <ScanSheetView open={open} onClose={onClose} linking={state} {...copy} />;
};

const useStyles = themedStyles((colours) => ({
  instruction: {
    ...mobileType.callout,
    lineHeight: 20,
    color: colours.textDefault,
    paddingHorizontal: 4,
  },
  segments: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
  },
  segment: { flex: 1, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  segmentOn: { backgroundColor: colours.raised },
  segmentText: { ...mobileType.subhead, color: colours.textSubtle },
  segmentTextOn: { color: colours.textStrong, fontWeight: "500" },
  pasteCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
    padding: 14,
    gap: 12,
  },
  input: {
    ...mobileType.command,
    color: colours.textDefault,
    minHeight: 96,
    textAlignVertical: "top",
  },
  link: {
    alignSelf: "flex-end",
    height: 36,
    paddingHorizontal: 18,
    borderRadius: 18,
    justifyContent: "center",
    backgroundColor: colours.textStrong,
  },
  linkText: { ...mobileType.label, color: colours.panel },
  wide: {
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  wideText: { ...mobileType.heading, fontWeight: "600", color: colours.textStrong },
  pressed: { transform: [{ scale: 0.97 }] },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
  },
  statusMark: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colours.textStrong,
  },
  statusText: { flex: 1, gap: 2 },
  statusTitle: { ...mobileType.heading, fontWeight: "500", color: colours.textStrong },
  statusDetail: { ...mobileType.footnote, lineHeight: 18, color: colours.textSubtle },
  failure: {
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
  },
  failureHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  failureDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colours.failed },
  failureKicker: {
    fontFamily: mobileFont.mono,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "500",
    letterSpacing: 0.8,
    color: colours.failedText,
  },
  failureMessage: {
    fontFamily: mobileFont.mono,
    fontSize: 13,
    lineHeight: 19,
    color: colours.textDefault,
  },
  primary: {
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colours.textStrong,
  },
  primaryText: { ...mobileType.heading, fontWeight: "600", color: colours.panel },
  textButton: { alignSelf: "center", paddingVertical: 2 },
  textButtonText: { ...mobileType.label, lineHeight: 20, color: colours.textSubtle },
  pressedText: { opacity: 0.6 },
}));
