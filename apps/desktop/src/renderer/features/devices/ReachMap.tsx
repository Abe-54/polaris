/**
 * The reach map (Paper SR-08): linked devices, the Polaris Relay, hosts, and packets crossing
 * live routes. Packets are WAAPI transform and opacity loops, mounted only while they may move.
 */
import { cn, reducedMotion } from "@polaris/ui";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceSummary, HostRelay } from "./model.ts";
import {
  type Cubic,
  deviceCurve,
  type DeviceLine,
  deviceNodes,
  flowingSegments,
  hostCurve,
  hostLeft,
  type HostLine,
  hostNodes,
  keyframes,
  LOOP_MS,
  MAP,
  mapHeight,
  PACKETS_PER_SEGMENT,
  pathOf,
  relayLeft,
  reversed,
  rowCentre,
  track,
} from "./reach.ts";

/** Paper's well width, until the well is measured. */
const FALLBACK_WIDTH = 842;

const CHIP_EDGE = "border-[light-dark(#00000014,#ffffff14)]";

const DASHED = "border-dashed border-[light-dark(#00000029,#ffffff29)]";

const STROKE: Readonly<Record<HostLine | DeviceLine, { stroke: string; dash?: string }>> = {
  live: { stroke: "var(--color-text-subtle)" },
  connecting: { stroke: "var(--color-text-subtle)", dash: "3 4" },
  away: { stroke: "light-dark(#00000024, #ffffff24)" },
  faint: { stroke: "light-dark(#0000001f, #ffffff1f)", dash: "1 5" },
};

/** Whether packets may move: the map is on screen, the window shown, and motion allowed. */
export const useMayMove = (ref: RefObject<HTMLElement | null>): boolean => {
  const [inView, setInView] = useState(true);
  const [shown, setShown] = useState(() => document.visibilityState === "visible");
  const [motion, setMotion] = useState(() => !reducedMotion());

  useEffect(() => {
    const element = ref.current;

    if (element === null) return;

    const intersection = new IntersectionObserver((entries) => {
      const last = entries.at(-1);

      if (last !== undefined) setInView(last.isIntersecting);
    });

    const onVisibility = () => setShown(document.visibilityState === "visible");
    const onMotion = () => setMotion(!reducedMotion());
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const setting = new MutationObserver(onMotion);

    intersection.observe(element);
    document.addEventListener("visibilitychange", onVisibility);
    reduce.addEventListener("change", onMotion);
    setting.observe(document.documentElement, { attributeFilter: ["data-reduce-motion"] });
    onVisibility();
    onMotion();

    return () => {
      intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduce.removeEventListener("change", onMotion);
      setting.disconnect();
    };
  }, [ref]);

  return inView && shown && motion;
};

const useWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const element = ref.current;

    if (element === null) return;

    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return width;
};

/** One packet: a 4px square and its 2px trail at 40%, a third of a loop per `phase`. */
const Packet = ({ curve, phase }: { readonly curve: Cubic; readonly phase: number }) => {
  const head = useRef<HTMLSpanElement>(null);
  const trail = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const { points, length } = track(curve);
    const start = (phase / PACKETS_PER_SEGMENT) * LOOP_MS;
    const lag = length === 0 ? 0 : (6 / length) * LOOP_MS;
    const timing = { duration: LOOP_MS, iterations: Infinity, easing: "linear" } as const;

    const moving = [
      head.current?.animate(keyframes(points, 4, 1), { ...timing, delay: -start }),
      trail.current?.animate(keyframes(points, 2, 0.4), { ...timing, delay: lag - start }),
    ];

    // cancel() rejects `finished`, which nothing awaits.
    for (const animation of moving) animation?.finished.catch(() => undefined);

    return () => {
      for (const animation of moving) animation?.cancel();
    };
  }, [curve, phase]);

  return (
    <>
      <span
        ref={trail}
        aria-hidden
        className="bg-text-strong absolute top-0 left-0 size-0.5 opacity-0"
      />
      <span
        ref={head}
        aria-hidden
        data-testid="packet"
        className="bg-text-strong absolute top-0 left-0 size-1 opacity-0"
      />
    </>
  );
};

const HostChip = ({
  label,
  colour,
  word,
  line,
  top,
  left,
  onTurnOn,
}: {
  readonly label: string;
  readonly colour: string;
  readonly word: string | null;
  readonly line: HostLine;
  readonly top: number;
  readonly left: number;
  readonly onTurnOn: () => void;
}) => {
  const faint = line === "faint";

  return (
    <div
      data-testid="reach-host"
      className={cn(
        "absolute flex items-center gap-2 rounded-[10px] border pl-3",
        word === null ? "pr-1.5" : "pr-3",
        faint ? DASHED : cn(CHIP_EDGE, "bg-raised-control")
      )}
      style={{ top, left, width: MAP.hostW, height: MAP.chipH }}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-[2px]", faint && "opacity-(--opacity-dimmed)")}
        style={{ backgroundColor: colour }}
      />
      <span
        className={cn(
          "text-caption min-w-0 flex-1 truncate",
          faint ? "text-text-subtle" : "text-text-default"
        )}
      >
        {label}
      </span>
      {word === null ? (
        <button
          type="button"
          onClick={onTurnOn}
          className="text-text-default hover:bg-fill-hover flex h-6 shrink-0 items-center rounded-full bg-[light-dark(#0000000f,#ffffff0f)] px-2.5 text-[11px] leading-4 font-medium"
        >
          Turn on
        </button>
      ) : (
        <span className="text-text-subtle shrink-0 font-mono text-[10px] leading-3 uppercase">
          {word}
        </span>
      )}
    </div>
  );
};

/** Each key's line, and the same curve walked from its far end: packets go host → relay → device. */
const curvesFor = (
  keys: string,
  pitch: number,
  height: number,
  curveAt: (cy: number) => Cubic
): ReadonlyMap<string, { readonly line: Cubic; readonly flow: Cubic }> => {
  const list = keys === "" ? [] : keys.split("\n");

  return new Map(
    list.map((key, i) => {
      const line = curveAt(rowCentre(i, list.length, pitch, height));

      return [key, { line, flow: reversed(line) }];
    })
  );
};

const RelayGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="text-text-strong">
    <path d="M6 0l1.3 4.7L12 6l-4.7 1.3L6 12l-1.3-4.7L0 6l4.7-1.3z" fill="currentColor" />
  </svg>
);

export const ReachMap = ({
  hosts,
  devices,
  colourOf,
  now,
  onTurnOn,
}: {
  readonly hosts: ReadonlyArray<HostRelay>;
  readonly devices: ReadonlyArray<DeviceSummary>;
  readonly colourOf: (hostKey: string) => string;
  readonly now: number;
  readonly onTurnOn: () => void;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const mayMove = useMayMove(box);
  const height = mapHeight(hosts.length, devices.length);
  const hostRows = hostNodes(hosts);
  const deviceRows = deviceNodes(hosts, devices, now);
  const relayX = relayLeft(width);
  const hostX = hostLeft(width);

  const hostKeys = hostRows.map((h) => h.key).join("\n");
  const deviceKeys = deviceRows.map((d) => d.key).join("\n");

  const hostCurves = useMemo(
    () => curvesFor(hostKeys, MAP.hostPitch, height, (cy) => hostCurve(cy, width, height)),
    [hostKeys, width, height]
  );

  const deviceCurves = useMemo(
    () => curvesFor(deviceKeys, MAP.devicePitch, height, (cy) => deviceCurve(cy, width, height)),
    [deviceKeys, width, height]
  );

  const flows = mayMove
    ? flowingSegments(hosts, devices, now).flatMap((s) => {
        const curves = (s.kind === "host" ? hostCurves : deviceCurves).get(s.key);

        return curves === undefined ? [] : [{ id: `${s.kind}:${s.key}`, curve: curves.flow }];
      })
    : [];

  return (
    <div
      ref={box}
      role="group"
      aria-label="Reach map"
      data-testid="reach-map"
      className="relative overflow-clip"
      style={{ height }}
    >
      <svg width={width} height={height} aria-hidden className="absolute top-0 left-0">
        {deviceRows.map((d) => {
          const curve = deviceCurves.get(d.key)?.line;
          const style = STROKE[d.line];

          return curve === undefined ? null : (
            <path
              key={d.key}
              d={pathOf(curve)}
              fill="none"
              strokeWidth={1.2}
              strokeDasharray={style.dash}
              style={{ stroke: style.stroke }}
              data-line={d.line}
            />
          );
        })}
        {hostRows.map((h) => {
          const curve = hostCurves.get(h.key)?.line;
          const style = STROKE[h.line];

          return curve === undefined ? null : (
            <path
              key={h.key}
              d={pathOf(curve)}
              fill="none"
              strokeWidth={1.2}
              strokeDasharray={style.dash}
              style={{ stroke: style.stroke }}
              data-line={h.line}
            />
          );
        })}
      </svg>
      {flows.flatMap(({ id, curve }) =>
        Array.from({ length: PACKETS_PER_SEGMENT }, (_, phase) => (
          <Packet key={`${id}:${phase}`} curve={curve} phase={phase} />
        ))
      )}
      {deviceRows.map((d, i) => (
        <div
          key={d.key}
          data-testid="reach-device"
          className={cn(
            "bg-raised-control absolute flex items-center gap-2 rounded-[10px] border px-3",
            CHIP_EDGE,
            d.line === "away" && "opacity-70"
          )}
          style={{
            top: rowCentre(i, deviceRows.length, MAP.devicePitch, height) - MAP.chipH / 2,
            left: MAP.pad,
            width: MAP.deviceW,
            height: MAP.chipH,
          }}
        >
          <span className="text-caption text-text-default min-w-0 flex-1 truncate">{d.name}</span>
          <span className="text-text-faint shrink-0 font-mono text-[10px] leading-3 uppercase">
            {d.age}
          </span>
        </div>
      ))}
      <div
        className="absolute flex flex-col items-center justify-center rounded-[12px] border border-[light-dark(#0000001f,#ffffff1f)] bg-[light-dark(#ffffff,#2e2f34)]"
        style={{
          top: height / 2 - MAP.relayH / 2,
          left: relayX,
          width: MAP.relayW,
          height: MAP.relayH,
        }}
      >
        <RelayGlyph />
        <span className="text-text-subtle mt-1 font-mono text-[10px] leading-3 tracking-[0.06em]">
          RELAY
        </span>
      </div>
      {hostRows.map((h, i) => (
        <HostChip
          key={h.key}
          label={h.label}
          colour={colourOf(h.key)}
          word={h.word}
          line={h.line}
          top={rowCentre(i, hostRows.length, MAP.hostPitch, height) - MAP.chipH / 2}
          left={hostX}
          onTurnOn={onTurnOn}
        />
      ))}
    </div>
  );
};
