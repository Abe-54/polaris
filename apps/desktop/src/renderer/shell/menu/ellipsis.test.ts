import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { ellipsisProblem } from "@polaris/ui";
import { KEYMAP, paletteEntry } from "../../../shared/keymap.ts";
import { labelProblem, menuLabels } from "./ellipsisScan.ts";

const ROOTS = [
  fileURLToPath(new URL("../../", import.meta.url)),
  fileURLToPath(new URL("../../../../../../packages/ui/src/", import.meta.url)),
  fileURLToPath(new URL("../../../../../../packages/ui/gallery/", import.meta.url)),
];

const sources = ROOTS.flatMap((root) =>
  [...new Bun.Glob("**/*.{ts,tsx}").scanSync(root)].flatMap((f) =>
    /\.test\.tsx?$/.test(f) ? [] : [`${root}${f}`]
  )
);

describe("rule/ellipsis-means-input", () => {
  test("a menu item ends in … exactly when it declares needsInput", async () => {
    const problems: Array<string> = [];

    for (const file of sources) {
      const source = await Bun.file(file).text();

      for (const found of menuLabels(file, source)) {
        const problem = labelProblem(found);

        if (problem !== null) problems.push(`${found.file}:${found.line} ${problem}`);
      }
    }

    expect(problems).toEqual([]);
  });

  test("KEYMAP titles end in … exactly when the command needs input", () => {
    const problems = KEYMAP.flatMap((b) => {
      const needs = b.needsInput === true;
      const palette = paletteEntry(b);
      const titles = [b.title, palette?.title].filter((t) => t !== undefined);
      const followUp = palette?.followUp === true && !needs ? [`${b.id} follows up`] : [];

      return [...titles.flatMap((t) => ellipsisProblem(t, needs) ?? []), ...followUp];
    });

    expect(problems).toEqual([]);
  });

  test("the scan catches an ellipsis without input, input without one, and three dots", () => {
    const sample = [
      `<ContextMenuItem onSelect={go}>Rename…</ContextMenuItem>`,
      `<ContextMenuItem needsInput onSelect={go}>Rename</ContextMenuItem>`,
      `<DropdownMenuItem onSelect={() => a > b}>Fork...</DropdownMenuItem>`,
      `<DropdownMenuItem needsInput onSelect={go}>Fork…</DropdownMenuItem>`,
      `const a = { kind: "item", label: "Delete…", onSelect: go };`,
      `const b = { kind: "item", label: "Delete…", needsInput: true, onSelect: go };`,
      `const c = { kind: "item", label: open ? "Close" : "Open", onSelect: go };`,
    ].join("\n");

    const flagged = menuLabels("sample.tsx", sample)
      .filter((f) => labelProblem(f) !== null)
      .map((f) => f.line);

    expect(flagged).toEqual([1, 2, 3, 5]);
  });
});
