import { useEffect, useState } from "react";

import { SegmentedControl, Switch, Toaster, TooltipProvider, Wordmark } from "../src";
import { Catalog } from "./catalog";
import { Orchestrate } from "./orchestrate";

type Page = "components" | "orchestrate";

type Density = "calm" | "balanced" | "compact";

type Theme = "dark" | "midnight" | "light";

const params = new URLSearchParams(window.location.search);

function param<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(name);

  return allowed.find((candidate) => candidate === value) ?? fallback;
}

const PAGES: readonly Page[] = ["components", "orchestrate"];

const DENSITIES: readonly Density[] = ["calm", "balanced", "compact"];

const THEMES: readonly Theme[] = ["dark", "midnight", "light"];

const TEXT_SIZES = ["small", "default", "large", "larger"] as const;

type TextSize = (typeof TEXT_SIZES)[number];

/** Query params make every state reachable for screenshots: ?page, ?density, ?theme, ?chrome=0. */
export function App() {
  const [page, setPage] = useState<Page>(param("page", PAGES, "components"));
  const [density, setDensity] = useState<Density>(param("density", DENSITIES, "calm"));
  const [theme, setTheme] = useState<Theme>(param("theme", THEMES, "dark"));
  const [textSize, setTextSize] = useState<TextSize>(param("text", TEXT_SIZES, "default"));
  const [cvd, setCvd] = useState(params.get("cvd") === "1");
  const [reduceMotion, setReduceMotion] = useState(params.get("reduce") === "1");
  const chrome = params.get("chrome") !== "0";

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  // reducedMotion() and the CSS read it from the root, as the app sets it.
  useEffect(() => {
    if (reduceMotion) document.documentElement.dataset["reduceMotion"] = "true";
    else delete document.documentElement.dataset["reduceMotion"];
  }, [reduceMotion]);

  return (
    <TooltipProvider>
      <div className="min-h-screen">
        {chrome ? (
          <header className="border-hairline bg-surface-sunken sticky top-0 z-40 flex h-12 items-center gap-4 border-b px-4">
            <Wordmark />
            <SegmentedControl
              aria-label="Page"
              value={page}
              onValueChange={setPage}
              options={[
                { value: "components", label: "Components" },
                { value: "orchestrate", label: "Artboard 5" },
              ]}
            />
            <span className="flex-1" />
            <SegmentedControl
              aria-label="Density"
              value={density}
              onValueChange={setDensity}
              options={DENSITIES.map((value) => ({ value, label: value }))}
            />
            <SegmentedControl
              aria-label="Theme for pages and portals"
              value={theme}
              onValueChange={setTheme}
              options={THEMES.map((value) => ({ value, label: value }))}
            />
            <SegmentedControl
              aria-label="Text size"
              value={textSize}
              onValueChange={setTextSize}
              options={TEXT_SIZES.map((value) => ({ value, label: value }))}
            />
            <label className="text-caption text-text-subtle flex items-center gap-2">
              <Switch checked={cvd} onCheckedChange={setCvd} />
              CVD diffs
            </label>
            <label className="text-caption text-text-subtle flex items-center gap-2">
              <Switch checked={reduceMotion} onCheckedChange={setReduceMotion} />
              Reduce motion
            </label>
          </header>
        ) : null}
        {page === "components" ? (
          <Catalog
            density={density}
            textSize={textSize}
            palette={cvd ? "cvd" : "default"}
            only={params.get("only")}
          />
        ) : (
          <Orchestrate density={density} theme={theme} />
        )}
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
