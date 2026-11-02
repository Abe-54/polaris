import { expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { McpBinding } from "../../mcp/binding.ts";
import { constellationTools } from "../../mcp/tools.ts";
import { fakeCommands, leadBinding, workerBinding } from "../../mcp/testing.ts";
import { constellationInstructions } from "./index.ts";
import { polarisInstructions, polarisPreamble } from "./preamble.ts";

const attachment = (binding: McpBinding) => ({
  sessionId: binding.sessionId,
  url: "http://127.0.0.1:12345/mcp/test",
  instructions: constellationInstructions(binding),
  tools: constellationTools(binding, fakeCommands().commands),
});

test("plain, Lead and worker receive common context and only their attached capabilities", () => {
  const plain = attachment(
    McpBinding.cases.Plain.make({
      sessionId: leadBinding.sessionId,
      constellationId: leadBinding.constellationId,
      workspaceId: WorkspaceId.make("workspace"),
    })
  );

  const lead = attachment(leadBinding);
  const worker = attachment(workerBinding);

  for (const current of [plain, lead, worker]) {
    const text = polarisPreamble({ constellation: current });
    expect(text).toContain("You are running inside Polaris");
    expect(text).toContain("Desktop App");
    expect(text).toContain("claim reports completed work for review, not acceptance");
    expect(text).toContain("Review:");
    expect(text).toContain("Workspaces:");
    expect(text).toContain("Hosts:");
    expect(text).toContain("mcp__polaris__search_history");
  }

  for (const current of [plain, lead]) {
    const text = polarisPreamble({ constellation: current });
    expect(text).toContain("mcp__polaris__plan");
    expect(text).not.toContain("mcp__polaris__claim");
  }

  expect(polarisPreamble({ constellation: worker })).toContain("mcp__polaris__claim");
  expect(polarisPreamble({ constellation: worker })).not.toContain("mcp__polaris__plan");
  expect(polarisInstructions({ constellation: lead })).toContain(lead.instructions);
  expect(polarisInstructions({ constellation: worker })).toContain(worker.instructions);
});

test("read-only and unattached sessions advertise no Constellation tools or role skills", () => {
  const lead = attachment(leadBinding);

  for (const options of [{}, { readOnly: true, constellation: lead }]) {
    const text = polarisInstructions(options);
    expect(text).toContain("You are running inside Polaris");
    // ENG-759: an agent assumed the user saw images only its tool results carried.
    expect(text).toContain("image() inside exec, never reach the user");
    expect(text).not.toContain("mcp__");
    expect(text).not.toContain(lead.instructions);
  }
});

test("a Gate retains both skills and names each separate server once", () => {
  const lead = attachment(leadBinding);
  const worker = attachment(workerBinding);
  const text = polarisInstructions({ constellations: [lead, worker] });
  expect(text.match(/You are running inside Polaris/g)).toHaveLength(1);
  expect(text).toContain("mcp__polaris__plan");
  expect(text).toContain("mcp__polaris_1__claim");
  expect(text).toContain(lead.instructions);
  expect(text).toContain(worker.instructions);
});
