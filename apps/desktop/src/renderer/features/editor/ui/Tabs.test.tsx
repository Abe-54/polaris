import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { TabView } from "../runtime/hooks.ts";
import { Tabs } from "./Tabs.tsx";

afterEach(cleanup);

const tab = (n: number): TabView => ({
  id: `/repo/file${n}.ts`,
  path: `/repo/file${n}.ts`,
  label: `file${n}.ts`,
  preview: false,
  dirty: false,
  agent: null,
});

/** The strip at `width` px with `content` px of tabs, as layout would measure it. */
const measured = (strip: HTMLElement, width: number, content: number) => {
  Object.defineProperty(strip, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(strip, "scrollWidth", { configurable: true, value: content });
};

test("tabs past the strip's edge fade that edge, and only that edge", () => {
  const screen = render(
    <Tabs
      tabs={Array.from({ length: 40 }, (_, n) => tab(n))}
      active="/repo/file0.ts"
      onSelect={() => undefined}
      onPin={() => undefined}
      onClose={() => undefined}
    />
  );

  const strip = screen.getByRole("tablist", { name: "Open files" });

  measured(strip, 800, 4000);
  fireEvent.scroll(strip);
  expect(strip.dataset["fade"]).toBe("end");

  strip.scrollLeft = 1600;
  fireEvent.scroll(strip);
  expect(strip.dataset["fade"]).toBe("both");

  strip.scrollLeft = 3200;
  fireEvent.scroll(strip);
  expect(strip.dataset["fade"]).toBe("start");
});

test("tabs that all fit have no fade", () => {
  const screen = render(
    <Tabs
      tabs={[tab(1)]}
      active="/repo/file1.ts"
      onSelect={() => undefined}
      onPin={() => undefined}
      onClose={() => undefined}
    />
  );

  expect(screen.getByRole("tablist").dataset["fade"]).toBe("none");
});
