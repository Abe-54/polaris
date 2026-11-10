/**
 * The scan sheet's viewfinder (Paper MX-AU): the camera in a well behind corner brackets, or the
 * line that asks for the camera when it isn't allowed.
 */
import { mobileType } from "@polaris/ui/tokens";
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { CHROME_TEXT_SCALE } from "../theme/textScale.ts";
import { themedStyles, useTheme } from "../theme/index.ts";

/** The well and its corner marks, so the caption can keep clear of them. */
const WELL_HEIGHT = 224;

const FRAME = 152;

/** Under the corner marks: a caption taller than this moves into the frame. */
const BELOW_FRAME = (WELL_HEIGHT - FRAME) / 2;

const CAPTION_BOTTOM = 14;

/** The caption's inset from the frame's edges inside it, clear of the corner marks. */
const FRAME_INSET = 18;

const BRACKETS =
  "M2 30V10a8 8 0 0 1 8-8h20M102 2h20a8 8 0 0 1 8 8v20M130 102v20a8 8 0 0 1-8 8h-20M30 130H10a8 8 0 0 1-8-8v-20";

const Camera = ({ onCode }: { readonly onCode: (text: string) => void }) => {
  const styles = useStyles();
  const [permission, request] = useCameraPermissions();

  if (permission?.granted === true)
    return (
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(result: BarcodeScanningResult) => onCode(result.data)}
      />
    );

  return (
    <Pressable
      style={styles.cameraOff}
      accessibilityRole="button"
      onPress={() => void request()}
      disabled={permission?.canAskAgain === false}
    >
      <Caption
        key={permission?.canAskAgain === false ? "off" : "ask"}
        text={
          permission?.canAskAgain === false
            ? "Camera access is off. Turn it on in Settings, or paste the link."
            : "Allow the camera to scan the code"
        }
      />
    </Pressable>
  );
};

/**
 * Under the corner marks while it fits there (MX-AU); a longer line or larger Dynamic Type moves it
 * inside the frame, padded off the corners, and shrinks it to fit.
 */
const Caption = ({ text }: { readonly text: string }) => {
  const styles = useStyles();
  const [inside, setInside] = useState(false);

  if (inside)
    return (
      <View style={styles.frameCentre}>
        <View style={styles.insideFrame}>
          <Text
            maxFontSizeMultiplier={CHROME_TEXT_SCALE}
            style={styles.cameraOffText}
            numberOfLines={5}
            adjustsFontSizeToFit
          >
            {text}
          </Text>
        </View>
      </View>
    );

  return (
    <Text
      maxFontSizeMultiplier={CHROME_TEXT_SCALE}
      style={[styles.cameraOffText, styles.belowFrame]}
      onLayout={({ nativeEvent }) => {
        if (nativeEvent.layout.height + CAPTION_BOTTOM > BELOW_FRAME) setInside(true);
      }}
    >
      {text}
    </Text>
  );
};

/** Scans only while `scanning`; otherwise the well stays as a still frame. */
export const Viewfinder = ({
  scanning,
  onCode,
}: {
  readonly scanning: boolean;
  readonly onCode: (text: string) => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <View style={styles.well}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <RadialGradient id="viewfinder-glow" cx="50%" cy="40%" r="70%">
            <Stop offset="0" stopColor={colours.raised} />
            <Stop offset="1" stopColor={colours.well} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#viewfinder-glow)" />
      </Svg>
      {scanning ? <Camera onCode={onCode} /> : null}
      <Svg width={FRAME} height={FRAME} viewBox="0 0 132 132" pointerEvents="none">
        <Path
          d={BRACKETS}
          fill="none"
          stroke={colours.textStrong}
          strokeWidth={3}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  well: {
    height: WELL_HEIGHT,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraOff: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "flex-end" },
  cameraOffText: { ...mobileType.footnote, color: colours.textSubtle, textAlign: "center" },
  belowFrame: { paddingHorizontal: 24, marginBottom: CAPTION_BOTTOM },
  frameCentre: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  insideFrame: {
    width: FRAME - 2 * FRAME_INSET,
    height: FRAME - 2 * FRAME_INSET,
    alignItems: "center",
    justifyContent: "center",
  },
}));
