/** The Review's round Back button, on the Review and on the states before it opens. */
import { Pressable } from "react-native";
import Svg, { Path } from "react-native-svg";
import { themedStyles, useTheme } from "../../theme/index.ts";

export const BackButton = ({ onPress }: { readonly onPress: () => void }) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={styles.back}
      onPress={onPress}
    >
      <Svg width={10} height={16} viewBox="0 0 10 16">
        <Path
          d="M7.5 2L2 8l5.5 6"
          fill="none"
          stroke={colours.textStrong}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </Pressable>
  );
};

const useStyles = themedStyles((colours) => ({
  back: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colours.panel,
    borderWidth: 1,
    borderColor: colours.hairline,
  },
}));
