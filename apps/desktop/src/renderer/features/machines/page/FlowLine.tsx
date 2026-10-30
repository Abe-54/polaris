/**
 * Remote access's pixel line art (Paper HS-D, the hosts popover's flow-line idiom): host →
 * relay → device, or host → device. Dashed with Starlight packets when live, dotted when off.
 */
import { cn } from "@polaris/ui";

export type Flow = "live" | "connecting" | "off";

const NODE = "var(--color-text-default)";

const LINE = "var(--color-text-subtle)";

const OFF = "var(--color-text-faint)";

const Link = ({
  from,
  to,
  flow,
}: {
  readonly from: number;
  readonly to: number;
  readonly flow: Flow;
}) => (
  <>
    <line
      x1={from}
      y1="10"
      x2={to}
      y2="10"
      style={{ stroke: flow === "off" ? OFF : LINE }}
      strokeDasharray={flow === "off" ? "1 4" : "2 2"}
    />
    {flow === "live" ? (
      <rect
        x={Math.round((from + to) / 2) - 2}
        y="9"
        width="2"
        height="2"
        style={{ fill: "var(--color-starlight)" }}
      />
    ) : null}
  </>
);

/** 120×20: the host on the left, the device on the right, the relay between when there is one. */
export const FlowLine = ({
  flow,
  via,
  className,
}: {
  readonly flow: Flow;
  /** "relay": through the Polaris Relay to a phone; "direct": straight to another device. */
  readonly via: "relay" | "direct";
  readonly className?: string;
}) => {
  const node = { fill: "none", stroke: flow === "off" ? OFF : NODE };

  return (
    <svg
      width="120"
      height="20"
      viewBox="0 0 120 20"
      aria-hidden
      data-flow={flow}
      className={cn("shrink-0 [shape-rendering:crispEdges]", className)}
    >
      <rect x="0" y="6" width="10" height="8" style={node} />
      {via === "relay" ? (
        <>
          <Link from={12} to={52} flow={flow} />
          <path d="M55 5h10v10H55z" style={node} />
          <Link from={67} to={106} flow={flow} />
          <rect x="110" y="3" width="7" height="14" rx="1" style={node} />
        </>
      ) : (
        <>
          <Link from={12} to={106} flow={flow} />
          <rect x="108" y="5" width="12" height="10" style={node} />
        </>
      )}
    </svg>
  );
};
