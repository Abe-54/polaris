import "../../../test/dom.testing.ts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { $getRoot, $getSelection, $isRangeSelection, getNearestEditorFromDOMNode } from "lexical";
import { useRef, useState } from "react";
import type { CommandOption } from "../model/commands.ts";
import type { MentionSearch } from "../model/mentions.ts";
import PromptEditor from "./PromptEditor.tsx";

const option = (name: string, extra: Partial<CommandOption> = {}): CommandOption => ({
  name,
  sigil: "/",
  description: `${name} it`,
  argumentHint: null,
  kind: "skill",
  source: "project",
  plugin: null,
  run: "text",
  action: null,
  template: null,
  ...extra,
});

const OPTIONS = [option("simplify"), option("compact", { kind: "command", source: "built-in" })];

/** The Host's file index, faked at the boundary: paths holding every letter of the query, in order. */
const INDEX = ["src/app.ts", "src/components/Button.tsx", "README.md", "docs/guide.md"];

const fakeIndex = () =>
  jest.fn<MentionSearch>((query) =>
    Promise.resolve({
      paths: INDEX.filter((path) => {
        let at = 0;

        for (const c of query.toLowerCase()) {
          at = path.toLowerCase().indexOf(c, at) + 1;

          if (at === 0) return false;
        }

        return true;
      }),
      failed: null,
    })
  );

/** A composer whose ↵ records what the Turn would send: the draft, as `SessionComposer` sends it. */
const Composer = ({
  search,
  sent,
  history,
}: {
  search: MentionSearch;
  sent: Array<string>;
  history?: (() => ReadonlyArray<string>) | undefined;
}) => {
  const [value, setValue] = useState("");
  const draft = useRef("");
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div>
      <div ref={setSlot} data-testid="slot" />
      <PromptEditor
        value={value}
        onChange={(text) => {
          draft.current = text;
          setValue(text);
        }}
        placeholder="Message"
        disabled={false}
        autoFocus
        options={OPTIONS}
        loading={false}
        onSubmit={() => sent.push(draft.current)}
        onEscape={() => false}
        takesFiles={false}
        onAction={() => undefined}
        menuSlot={slot}
        notice={null}
        frecency={{}}
        onPicked={() => undefined}
        mentions={search}
        history={history}
      />
    </div>
  );
};

const input = () => {
  const element = document.querySelector<HTMLElement>('[data-testid="composer-input"]');

  if (element === null) throw new Error("no composer");

  return element;
};

const editor = () => {
  const found = getNearestEditorFromDOMNode(input());

  if (found === null) throw new Error("no editor");

  return found;
};

/** Types at the caret, as keystrokes would, then lets the search answer and React render. */
const type = async (text: string) => {
  await act(async () => {
    editor().update(
      () => {
        const selection = $getSelection();

        ($isRangeSelection(selection) ? selection : $getRoot().selectEnd()).insertText(text);
      },
      { discrete: true }
    );
  });
  await act(async () => undefined);
};

const press = async (key: string) => {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await act(async () => undefined);
};

const mount = async (
  search: MentionSearch = fakeIndex(),
  history?: () => ReadonlyArray<string>
) => {
  const sent: Array<string> = [];

  render(<Composer search={search} sent={sent} history={history} />);
  await act(async () => undefined);

  return sent;
};

const options = (testId: string) => [
  ...document.querySelectorAll(`[data-testid="${testId}"] [role="option"]`),
];

const mentionRows = () => options("mention-menu").map((row) => row.getAttribute("aria-label"));

/** Each `/` menu row's name, as drawn with its sigil. */
const commandRows = () =>
  options("command-menu").map((row) => row.querySelector(".font-medium")?.textContent);

// happy-dom lays nothing out: the picker's list measures its 320px cap, as the window gives it.
const SIZES = ["offsetHeight", "offsetWidth"] as const;

const own = SIZES.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));

beforeEach(() => {
  for (const name of SIZES)
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset["testid"] === "mention-menu" ? 320 : 0;
      },
    });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  SIZES.forEach((name, i) => {
    const descriptor = own[i];

    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  });
});

describe("@ file mentions (ENG-544)", () => {
  test("@ opens the picker over the workspace's files; ↵ mentions one; the Turn sends @path", async () => {
    const search = fakeIndex();
    const sent = await mount(search);

    await type("look at @app");
    expect(search).toHaveBeenLastCalledWith("app");
    expect(mentionRows()).toEqual(["src/app.ts"]);

    await press("Enter");
    expect(document.querySelector('[data-testid="mention-menu"]')).toBeNull();
    expect(input().querySelector('[data-sigil="@"]')?.textContent).toBe("src/app.ts");

    await type("please");
    await press("Enter");
    expect(sent).toEqual(["look at @src/app.ts please"]);
  });

  test("a bare @ lists top-level folders first; ↓ moves, ⇥ goes into a folder", async () => {
    await mount();

    await type("@");
    expect(mentionRows().slice(0, 2)).toEqual(["docs/", "src/"]);

    await press("ArrowDown");
    await press("Tab");
    expect(input().textContent).toBe("@src/");
    expect(mentionRows()).toContain("src/components/Button.tsx");
  });

  test("esc closes the picker and leaves the literal @", async () => {
    const sent = await mount();

    await type("see @");
    expect(mentionRows().length).toBeGreaterThan(0);

    await press("Escape");
    expect(document.querySelector('[data-testid="mention-menu"]')).toBeNull();

    await press("Enter");
    expect(sent).toEqual(["see @"]);
  });

  test("an @ in an email, inside a word or in a code span doesn't open it", async () => {
    const search = fakeIndex();

    await mount(search);

    for (const text of ["mail me@example.com", " a@b", " `@app"]) await type(text);

    expect(search).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="mention-menu"]')).toBeNull();
  });
});

describe("/ Skills anywhere in the message (ENG-544)", () => {
  test("/ after text opens the menu with the Skills; the pick lands at the caret in what's sent", async () => {
    const sent = await mount();

    await type("fix the parser, then /");
    expect(commandRows()).toEqual(["/simplify"]);

    await type("sim");
    await press("Enter");
    await type("it");
    await press("Enter");
    expect(sent).toEqual(["fix the parser, then /simplify it"]);
  });

  test("/ inside a path or a URL doesn't open it", async () => {
    await mount();

    for (const text of ["see a/b", " ./src", " http://example.com/"]) {
      await type(text);
      expect(document.querySelector('[data-testid="command-menu"]')).toBeNull();
    }
  });
});

describe("↑/↓ through what was sent (ENG-903)", () => {
  test("↑ reads the history when pressed, not as the composer renders", async () => {
    const entries = ["fix the flaky test"];
    const read = jest.fn(() => [...entries]);

    await mount(fakeIndex(), read);
    await type("draft");
    await act(async () => editor().update(() => $getRoot().clear(), { discrete: true }));
    expect(read).not.toHaveBeenCalled();

    // Sent since the last render: ↑ still brings it back first.
    entries.push("now the docs");
    await press("ArrowUp");
    expect(input().textContent).toBe("now the docs");
    await press("ArrowUp");
    expect(input().textContent).toBe("fix the flaky test");
  });
});
