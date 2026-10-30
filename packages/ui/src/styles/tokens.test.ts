import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const tokens = read("./tokens.css");

const theme = read("./theme.css");

const design = read("../../../../DESIGN.md");

/** DESIGN.md frontmatter colours, "name: #hex". */
function designColours(): Map<string, string> {
  const frontmatter = design.split("---")[1] ?? "";
  const colours = new Map<string, string>();

  for (const match of frontmatter.matchAll(/^ {2}([a-z0-9-]+): "(#[0-9A-Fa-f]{6,8})"/gm)) {
    const [, name, hex] = match;

    if (name !== undefined && hex !== undefined) colours.set(name, hex.toLowerCase());
  }

  return colours;
}

function tokenValue(name: string): string | undefined {
  const match = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(tokens);

  return match?.[1]?.trim().toLowerCase();
}

describe("tokens", () => {
  const colours = designColours();

  test("reads DESIGN.md's colours", () => {
    expect(colours.size).toBeGreaterThan(40);
  });

  test("every -dark/-light pair in DESIGN.md is one light-dark() token", () => {
    let pairs = 0;

    for (const [name, dark] of colours) {
      if (!name.endsWith("-dark")) continue;

      const base = name.slice(0, -"-dark".length);
      const light = colours.get(`${base}-light`);

      if (light === undefined) continue;

      pairs += 1;
      expect(tokenValue(base)).toBe(`light-dark(${light}, ${dark})`);
    }

    expect(pairs).toBeGreaterThan(20);
  });

  test("every single-value DESIGN.md colour keeps its value in both themes", () => {
    for (const [name, value] of colours) {
      if (name.endsWith("-dark") || name.endsWith("-light")) continue;

      const token = tokenValue(name);

      expect(token === value || token?.endsWith(`, ${value})`)).toBe(true);
    }
  });

  test("clears Tailwind's palette, so only Polaris colours exist", () => {
    expect(tokens).toContain("--color-*: initial;");
    expect(tokens).toContain("@theme static");
  });
});

describe("theming", () => {
  test("dark is the default", () => {
    expect(theme).toMatch(/:root\s*\{\s*color-scheme: dark;/);
  });

  test("light follows data-theme and, unless a theme is set, the system", () => {
    expect(theme).toMatch(/\[data-theme="light"\]\s*\{\s*color-scheme: light;/);
    expect(theme).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{\s*color-scheme: light;/
    );
  });

  test("a subtree with a theme or a choice of dark resets its inherited colours", () => {
    expect(theme).toMatch(
      /\[data-theme\],\s*\[data-theme-dark\]\s*\{[^}]*background-color: var\(--color-bg\);[^}]*color: var\(--color-text-default\);/
    );
  });

  test("focus is a 2px Starlight ring with a 2px offset", () => {
    expect(theme).toMatch(
      /:focus-visible\s*\{\s*outline: 2px solid var\(--color-starlight\);\s*outline-offset: 2px;/
    );
  });
});

/** A theme.css block's `--color-*: light-dark(light, dark)` pairs, by token name. */
function flavour(selector: string): Map<string, readonly [string, string]> {
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(theme)?.[1] ?? "";

  return new Map(
    [...block.matchAll(/--color-([a-z0-9-]+):\s*light-dark\((#[0-9a-f]+), (#[0-9a-f]+)\);/g)].map(
      ([, name = "", light = "", dark = ""]) => [name, [light, dark] as const]
    )
  );
}

describe("the choice of dark", () => {
  const moonlit = flavour(String.raw`\[data-theme-dark="moonlit"\]`);
  const midnight = flavour(String.raw`\[data-theme="midnight"\],\s*\[data-theme-dark="midnight"\]`);

  test("both flavours set the chrome's surfaces and the hairline; Midnight also its diff fills", () => {
    for (const [block, extra] of [
      [moonlit, []],
      [midnight, ["diff-added-bg", "diff-removed-bg"]],
    ] as const) {
      expect([...block.keys()].sort()).toEqual(
        [
          "bg",
          "ground",
          "hairline",
          "panel",
          "raised",
          "raised-control",
          "surface-raised",
          "surface-sunken",
          "well",
          "well-raised",
          ...extra,
        ].sort()
      );
    }
  });

  test("a raised surface's wells sit one step off it: Moonlit's panel tone, Midnight's one well", () => {
    expect(theme).toMatch(
      /\[data-surface="raised"\]\s*\{\s*--color-well: var\(--color-well-raised\);\s*\}/
    );
    expect(moonlit.get("well-raised")?.[1]).toBe(moonlit.get("panel")?.[1]);
    expect(moonlit.get("well-raised")?.[0]).toBe(moonlit.get("well")?.[0]);
    expect(midnight.get("well-raised")).toEqual(midnight.get("well"));
  });

  test("Moonlit restores tokens.css exactly, so it can undo Midnight in a subtree", () => {
    for (const [name, [light, dark]] of moonlit) {
      expect(tokenValue(name)).toBe(`light-dark(${light}, ${dark})`);
    }
  });

  test("Midnight keeps light's arms, so a light theme under it is unchanged", () => {
    for (const [name, [light, dark]] of midnight) {
      expect(tokenValue(name)).toStartWith(`light-dark(${light}, `);
      expect(tokenValue(name)).not.toEndWith(`, ${dark})`);
    }
  });
});

describe("accessibility hooks", () => {
  test("the cvd palette remaps the diff colours, fills and emphasis", () => {
    const block = /\[data-diff-palette="cvd"\]\s*\{([^}]*)\}/.exec(theme)?.[1] ?? "";

    for (const name of ["added", "removed"]) {
      expect(block).toContain(`--color-diff-${name}: var(--color-diff-${name}-cvd);`);
      expect(block).toContain(`--color-diff-${name}-text: var(--color-diff-${name}-cvd-text);`);
      expect(block).toContain(`--color-diff-${name}-bg:`);
      expect(block).toContain(`--color-diff-${name}-emphasis:`);
    }
  });

  test("text size scales every type role, independent of density", () => {
    const block = /:root,\s*\[data-text-size\]\s*\{([^}]*)\}/.exec(theme)?.[1] ?? "";

    for (const role of [
      "display",
      "title",
      "heading",
      "heading-sm",
      "body",
      "label",
      "caption",
      "code",
      "code-inline",
      "micro",
    ]) {
      expect(block).toContain(`--text-${role}: round(calc(`);
      expect(block).toContain(`--text-${role}--line-height: round(calc(`);
    }

    expect(theme).toMatch(/\[data-text-size="large"\]\s*\{\s*--text-scale: calc\(14 \/ 13\);/);
  });
});

describe("motion tokens", () => {
  test("press, reveal and panel durations are DESIGN.md's, beside the house curve", () => {
    const motion =
      /Press is (\d+ms)\. Small reveals are (\d+ms)\. Panels and toasts are (\d+ms)\./.exec(design);

    expect(motion).not.toBeNull();

    const [, press, reveal, panel] = motion ?? [];

    expect(tokens).toContain(`--duration-press: ${press};`);
    expect(tokens).toContain(`--duration-reveal: ${reveal};`);
    expect(tokens).toContain(`--duration-panel: ${panel};`);
    expect(tokens).toContain("--default-transition-timing-function: var(--ease-out);");
  });
});
