import { expect, test } from "bun:test";
import { Attachment, AttachmentId } from "@polaris/protocol";
import { Effect } from "effect";
import { buildUserMessage } from "./input.ts";

const file = (name: string, mimeType: string, size: number) =>
  new Attachment({
    id: AttachmentId.make(name),
    name,
    mimeType,
    size,
    hostPath: `/stage/${name}`,
    width: null,
    height: null,
  });

test("a picked element's note goes inline in the prompt; other files stay paths (ENG-637)", async () => {
  const message = await Effect.runPromise(
    buildUserMessage({
      uuid: "00000000-0000-4000-8000-000000000001",
      prompt: "fix this",
      attachments: [file("pick.md", "text/markdown", 20), file("spec.pdf", "application/pdf", 9)],
      readFile: async () => new TextEncoder().encode("Selector: `#save`\n"),
    })
  );

  expect(message.message.content).toEqual([
    {
      type: "text",
      text: [
        "fix this",
        '<attached-file name="pick.md" type="text/markdown" path="/stage/pick.md">\nSelector: `#save`\n</attached-file>',
        "Attached files (staged on this machine; read them from these paths):\n- spec.pdf (application/pdf): /stage/spec.pdf",
      ].join("\n\n"),
    },
  ]);
});
