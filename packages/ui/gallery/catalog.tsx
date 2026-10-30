import type { ReactNode } from "react";

import { CelestialSection } from "./sections/celestial";
import { CopySection } from "./sections/copy";
import { CoverageSection } from "./sections/coverage";
import { ControlsSection, TypeSection, ColourSection } from "./sections/basics";
import { FloatingSection, ComposerSection } from "./sections/floating";
import { IdentitySection, SignalSection } from "./sections/identity";
import { ListSection } from "./sections/lists";
import { MobileTypeSection } from "./sections/mobile";
import { PixelWorldSection } from "./sections/pixel-world";
import { SettingsKitSection } from "./sections/settings";
import { WorstEdges, WorstSection } from "./sections/worst";

export interface CatalogProps {
  readonly density: string;
  readonly textSize: string;
  readonly palette: string;
  /** "coverage" renders only the M1 coverage components. */
  readonly only?: string | null;
}

/** ?only=… renders one section alone, for screenshots. */
const SOLO = new Map<string, ReactNode>([
  ["coverage", <CoverageSection key="coverage" />],
  ["celestial", <CelestialSection key="celestial" />],
  ["worst", <WorstSection key="worst" />],
  ["settings", <SettingsKitSection key="settings" />],
]);

interface ColumnProps extends CatalogProps {
  readonly theme: "dark" | "midnight" | "light";
}

function Column({ theme, density, textSize, palette, only }: ColumnProps) {
  return (
    <div
      data-theme={theme}
      data-density={density}
      data-text-size={textSize}
      data-diff-palette={palette}
      className="gap-section flex min-w-0 flex-1 flex-col p-6"
    >
      <p className="text-caption text-text-subtle">
        {theme} · {density} · text {textSize} · {palette} diffs
      </p>
      {(only == null ? undefined : SOLO.get(only)) ?? (
        <>
          <TypeSection />
          {theme === "midnight" ? <MobileTypeSection /> : null}
          <ColourSection />
          <ControlsSection />
          <CopySection />
          <IdentitySection />
          <CelestialSection />
          <SignalSection />
          <ListSection />
          <ComposerSection />
          <FloatingSection />
          <PixelWorldSection />
          <SettingsKitSection />
          <CoverageSection />
        </>
      )}
    </div>
  );
}

/** Every component and state, dark, midnight and light side by side. */
export function Catalog(props: CatalogProps) {
  // One theme only: these popovers portal to the page and open against its edges.
  if (props.only === "worst-edges" || props.only === "worst-edge-menus")
    return (
      <main data-theme="dark" data-density={props.density}>
        <WorstEdges menus={props.only === "worst-edge-menus"} />
      </main>
    );

  return (
    // The Settings kit alone gets its ~860px page column in each theme, so its cards go two-up.
    <main className={props.only === "settings" ? "flex min-w-[2880px]" : "flex min-w-[1920px]"}>
      <Column theme="dark" {...props} />
      <Column theme="midnight" {...props} />
      <Column theme="light" {...props} />
    </main>
  );
}
