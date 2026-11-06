import "../../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { PREVIEW_REHYPE, SAFE_HTML_COMPONENTS } from "./pipeline.tsx";

// Another DOM test file may have unregistered happy-dom already.
beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

const CSS = readFileSync(
  join(import.meta.dirname, "../../session/ui/markdown/markdown.css"),
  "utf8"
);

const NESTED = /&\s*([^{}]+?)\s*\{([^}]*)\}/g;

/** The `& selector { … }` rules nested in `.polaris-md`, as selector and declarations. */
const RULES = [...CSS.matchAll(NESTED)].flatMap(([, list, body]) =>
  (list ?? "")
    .split(/,\s*&\s*/)
    // Relative selectors (`> * + *`) only space blocks, and `matches` can't take them.
    .filter((selector) => !/^[>+~]|::/.test(selector))
    .map((selector) => ({ selector, body: body ?? "" }))
);

const SOURCE = ["# One", "## Two", "Some *em*, **strong** and `code`.", "> quote"].join("\n\n");

const rendered = () => {
  const root = document.createElement("div");

  root.innerHTML = renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        className: "polaris-md editor-markdown",
        rehypePlugins: PREVIEW_REHYPE,
        components: SAFE_HTML_COMPONENTS,
      },
      SOURCE
    )
  );

  return root;
};

/** Whether a rule that matches the element declares the property (the stylesheet, not Tailwind). */
const declares = (element: Element | null, declaration: RegExp) =>
  element !== null &&
  RULES.some((rule) => element.matches(rule.selector) && declaration.test(rule.body));

describe("the Markdown preview's own rules reach Streamdown's elements", () => {
  test("**strong** is semibold and text-strong, though Streamdown renders a span", () => {
    const strong = rendered().querySelector('[data-streamdown="strong"]');

    expect(strong?.textContent).toBe("strong");
    expect(declares(strong, /font-weight:\s*600/)).toBe(true);
    expect(declares(strong, /color:\s*var\(--color-text-strong\)/)).toBe(true);
  });

  test("headings are semibold text-strong; code is in the code font; quotes are subtle", () => {
    const root = rendered();

    for (const level of ["h1", "h2"])
      expect(declares(root.querySelector(level), /font-weight:\s*600/)).toBe(true);
    expect(declares(root.querySelector('[data-streamdown="inline-code"]'), /font-family/)).toBe(
      true
    );
    expect(declares(root.querySelector("blockquote"), /color:\s*var\(--color-text-subtle\)/)).toBe(
      true
    );
  });
});
