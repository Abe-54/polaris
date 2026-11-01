/** Settings' row glyphs (Paper MX-G), 16pt strokes in the row's text colour. */
import Svg, { Circle, Path, Rect } from "react-native-svg";

type Glyph = (props: { readonly color: string }) => React.JSX.Element;

export const HostsGlyph: Glyph = ({ color }) => (
  <Svg width={16} height={16} viewBox="0 0 16 16">
    <Rect x={2} y={3} width={12} height={4} rx={1.2} fill="none" stroke={color} strokeWidth={1.4} />
    <Rect x={2} y={9} width={12} height={4} rx={1.2} fill="none" stroke={color} strokeWidth={1.4} />
    <Circle cx={5} cy={5} r={0.9} fill={color} />
    <Circle cx={5} cy={11} r={0.9} fill={color} />
  </Svg>
);

export const NotificationsGlyph: Glyph = ({ color }) => (
  <Svg width={16} height={16} viewBox="0 0 16 16">
    <Path
      d="M4 11V7.5a4 4 0 0 1 8 0V11l1.2 1.5H2.8zM6.5 14h3"
      fill="none"
      stroke={color}
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const MotionGlyph: Glyph = ({ color }) => (
  <Svg width={16} height={16} viewBox="0 0 16 16">
    <Circle cx={8} cy={8} r={5.5} fill="none" stroke={color} strokeWidth={1.4} />
    <Path d="M8 5v3l2 1.5" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" />
  </Svg>
);

/** Angle brackets: Polaris's own code. */
export const DeveloperModeGlyph: Glyph = ({ color }) => (
  <Svg width={16} height={16} viewBox="0 0 16 16">
    <Path
      d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"
      fill="none"
      stroke={color}
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const Chevron = ({ color }: { readonly color: string }) => (
  <Svg width={8} height={13} viewBox="0 0 8 13">
    <Path
      d="M1.5 1.5l5 5-5 5"
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);
