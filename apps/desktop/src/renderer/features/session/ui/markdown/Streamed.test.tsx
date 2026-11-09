import "../../../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TooltipProvider } from "@polaris/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, test } from "bun:test";
import Streamed from "./Streamed.tsx";

// Another DOM test file may have unregistered happy-dom already.
beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(cleanup);

test("a table is as tall as its rows, never a scroll box", () => {
  const rows = Array.from({ length: 40 }, (_, row) => `| T${row} | task ${row} |`);
  const text = ["| Task | What |", "| --- | --- |", ...rows, ""].join("\n");

  const { container } = render(
    <TooltipProvider>
      <Streamed text={text} live={false} />
    </TooltipProvider>
  );

  const box = container.querySelector('[data-streamdown="table"]')?.parentElement;

  expect(container.querySelectorAll('[data-streamdown="table-row"]')).toHaveLength(41);
  expect(box?.style.maxHeight).toBe("");
});
