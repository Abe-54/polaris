import Svg, { Path } from "react-native-svg";

/** SF Symbol names used by the shared menu, drawn with the app's existing SVG strokes. */
export const MenuSymbol = ({
  symbol,
  color,
}: {
  readonly symbol: string | null;
  readonly color: string;
}) => {
  let path: string;

  switch (symbol) {
    case "doc.on.doc":
      path = "M9 9h12v12H9zM15 5V3H3v12h2";
      break;
    case "arrow.triangle.branch":
      path = "M6 21V3m-3 3 3-3 3 3M6 17c0-7 12-3 12-10V3m-3 3 3-3 3 3";
      break;
    default:
      return null;
  }

  return (
    <Svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
};
