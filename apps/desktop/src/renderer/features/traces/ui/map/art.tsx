/**
 * The service map's pictures in the Hosts card's line art (Paper X-F 05, T5): a rack server lit
 * in its service's hue, a dashed server for an inferred host, a dashed cylinder for a database.
 */
import {
  type At,
  INNER,
  LEFT,
  LINE,
  Placed,
  ServerGlyph,
  TOP,
} from "../../../machines/hostsCard/glyphs.tsx";
import type { NodeKind } from "../../model/map/index.ts";

/** A database drawn dashed, as inferred: nothing in it sent spans. */
const Database = ({ at }: { readonly at: At }) => {
  const dashed = { stroke: LINE, strokeDasharray: "3 2" };

  return (
    <Placed at={at} origin={{ x: 555, y: 444 }}>
      <path d="M523 378V430A32 14 0 0 0 587 430V378" style={{ fill: LEFT, ...dashed }} />
      <ellipse cx="555" cy="378" rx="32" ry="14" style={{ fill: TOP, ...dashed }} />
      <path
        d="M523 396A32 14 0 0 0 587 396M523 412A32 14 0 0 0 587 412"
        style={{ fill: "none", stroke: INNER }}
      />
    </Placed>
  );
};

/** One node's picture, its bottom vertex at `at`. */
export const NodeGlyph = ({
  kind,
  at,
  light,
}: {
  readonly kind: NodeKind;
  readonly at: At;
  readonly light: string | null;
}) => {
  if (kind === "database") return <Database at={at} />;

  return (
    <ServerGlyph at={at} light={kind === "service" ? light : null} dashed={kind === "remote"} />
  );
};
