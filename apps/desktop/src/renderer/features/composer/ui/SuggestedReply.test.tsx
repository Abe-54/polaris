import "../../../test/dom.testing.ts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  $getRoot,
  getNearestEditorFromDOMNode,
  PASTE_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";
import { useRef, useState } from "react";
import type { MentionSearch } from "../model/mentions.ts";
import type { OfferedReply } from "../model/suggestion.ts";
import PromptEditor from "./PromptEditor.tsx";

const REPLY: OfferedReply = { turnId: "t1", text: "go with B" };

const search: MentionSearch = () => Promise.resolve({ paths: ["src/app.ts"], failed: null });

/** A composer whose ↵ records the draft it would send, and whose esc records a stop. */
const Composer = ({
  suggestion,
  sent,
  stops,
}: {
  suggestion: OfferedReply | null;
  sent: Array<string>;
  stops: Array<true>;
}) => {
  const [value, setValue] = useState("");
  const draft = useRef("");
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div>
      <div ref={setSlot} />
      <PromptEditor
        value={value}
        onChange={(text) => {
          draft.current = text;
          setValue(text);
        }}
        placeholder="Message"
        disabled={false}
        autoFocus
        options={[]}
        loading={false}
        onSubmit={() => sent.push(draft.current)}
        onEscape={() => {
          stops.push(true);

          return true;
        }}
        takesFiles={false}
        onAction={() => undefined}
        menuSlot={slot}
        notice={null}
        frecency={{}}
        onPicked={() => undefined}
        mentions={search}
        suggestion={suggestion}
      />
    </div>
  );
};

const input = () => {
  const element = document.querySelector<HTMLElement>('[data-testid="composer-input"]');

  if (element === null) throw new Error("no composer");

  return element;
};

const editor = (): LexicalEditor => {
  const found = getNearestEditorFromDOMNode(input());

  if (found === null) throw new Error("no editor");

  return found;
};

const settle = () => act(async () => undefined);

const press = async (key: string) => {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
};

const type = async (text: string) => {
  await act(async () => {
    editor().update(() => $getRoot().selectEnd().insertText(text), { discrete: true });
  });
  await settle();
};

const text = () =>
  editor()
    .getEditorState()
    .read(() => $getRoot().getTextContent());

const ghost = () => document.querySelector('[data-testid="suggested-reply"]');

const announced = () => document.querySelector('[role="status"]')?.textContent ?? "";

const mount = async (suggestion: OfferedReply | null = REPLY) => {
  const sent: Array<string> = [];
  const stops: Array<true> = [];
  const view = render(<Composer suggestion={suggestion} sent={sent} stops={stops} />);

  await settle();

  const rerender = async (next: OfferedReply | null) => {
    view.rerender(<Composer suggestion={next} sent={sent} stops={stops} />);
    await settle();
  };

  return { sent, stops, rerender };
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("Suggested Reply in the composer (ENG-885)", () => {
  test("shows in the empty prompt in place of the placeholder, announced once", async () => {
    await mount();

    expect(ghost()?.textContent).toContain("go with B");
    expect(document.body.textContent).not.toContain("Message");
    expect(announced()).toBe("Suggested reply: go with B. Press Tab to use it.");
  });

  test("⇥ inserts it without sending, as one undoable edit", async () => {
    const { sent } = await mount();

    await press("Tab");
    expect(text()).toBe("go with B");
    expect(sent).toEqual([]);
    expect(ghost()).toBeNull();

    await act(async () => {
      editor().dispatchCommand(UNDO_COMMAND, undefined);
    });
    await settle();
    expect(text()).toBe("");
  });

  test("↵ after accepting sends it as edited", async () => {
    const { sent } = await mount();

    await press("Tab");
    await type("!");
    await press("Enter");
    expect(sent).toEqual(["go with B!"]);
  });

  test("clicking the ⇥ Tab chip inserts it without sending", async () => {
    const { sent } = await mount();

    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Use suggested reply"]'
    );

    await act(async () => chip?.click());
    await settle();
    expect(text()).toBe("go with B");
    expect(sent).toEqual([]);
  });

  test("typing dismisses it for the Turn: clearing the prompt doesn't bring it back", async () => {
    await mount();

    await type("n");
    await act(async () => {
      editor().update(() => $getRoot().clear(), { discrete: true });
    });
    await settle();
    expect(text()).toBe("");
    expect(ghost()).toBeNull();

    await press("Tab");
    expect(text()).toBe("");
  });

  test("paste dismisses it", async () => {
    await mount();
    const data = new DataTransfer();

    data.setData("text/plain", "pasted");
    await act(async () => {
      editor().dispatchCommand(
        PASTE_COMMAND,
        new ClipboardEvent("paste", { clipboardData: data, cancelable: true })
      );
    });
    await settle();
    expect(text()).toBe("pasted");

    await act(async () => {
      editor().update(() => $getRoot().clear(), { discrete: true });
    });
    await settle();
    expect(ghost()).toBeNull();
  });

  test("esc dismisses it without stopping anything; the next Turn's reply shows", async () => {
    const { stops, rerender } = await mount();

    await press("Escape");
    expect(ghost()).toBeNull();
    expect(stops).toEqual([]);

    await press("Tab");
    expect(text()).toBe("");

    await rerender({ turnId: "t2", text: "ship it" });
    expect(ghost()?.textContent).toContain("ship it");
  });

  test("an open @ picker keeps ⇥", async () => {
    await mount();

    await type("@app");
    await press("Tab");
    expect(input().querySelector('[data-sigil="@"]')?.textContent).toBe("src/app.ts");
    expect(text()).not.toContain("go with B");
  });

  test("gone when the session stops offering it (not Idle, or a newer Turn)", async () => {
    const { rerender } = await mount();

    await rerender(null);
    expect(ghost()).toBeNull();
    expect(announced()).toBe("");
    expect(document.body.textContent).toContain("Message");

    await press("Tab");
    expect(text()).toBe("");
  });
});
