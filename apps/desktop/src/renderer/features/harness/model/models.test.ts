import { describe, expect, test } from "bun:test";
import {
  choose,
  defaultChoice,
  effortFor,
  effortNote,
  findModel,
  type ModelData,
  modelChange,
  modelLabel,
  pickableModels,
} from "./models.ts";

const model = (id: string, patch: Partial<ModelData> = {}): ModelData => ({
  id,
  name: id.toUpperCase(),
  description: null,
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  isDefault: false,
  ...patch,
});

const claude = [
  model("default", { name: "Default (recommended)", isDefault: true, defaultEffort: null }),
  model("opus", { name: "Opus 5", efforts: ["low", "medium", "high", "max"], defaultEffort: null }),
  model("haiku", { name: "Haiku", efforts: [], defaultEffort: null }),
];

describe("Model picker", () => {
  test("Claude's default row is hidden; other Harnesses keep every row", () => {
    expect(pickableModels("claude", claude).map((m) => m.id)).toEqual(["opus", "haiku"]);
    expect(pickableModels("codex", claude)).toHaveLength(3);
  });

  test("the effort sent is the pick if supported, else the Model's default", () => {
    const gpt = model("gpt-5.5", { defaultEffort: "high" });

    expect(effortFor(gpt, "low")).toBe("low");
    expect(effortFor(gpt, "xhigh")).toBe("high");
    expect(choose(gpt)).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  test("with no default effort, Polaris sends medium (or the first) and says so", () => {
    const [, opus] = claude;
    const odd = model("odd", { efforts: ["quick", "deep"], defaultEffort: null });

    expect(opus === undefined ? null : choose(opus)).toEqual({ model: "opus", effort: "medium" });
    expect(choose(odd).effort).toBe("quick");
    expect(opus === undefined ? null : effortNote("Claude Code", opus)).toBe(
      "Claude Code doesn't say Opus 5's default effort; Polaris sends medium."
    );
    expect(effortNote("Codex", model("gpt"))).toBeNull();
  });

  test("a Model without efforts sends none", () => {
    const haiku = claude[2];

    expect(haiku === undefined ? null : choose(haiku)).toEqual({ model: "haiku", effort: null });
  });

  test("labels: null reads Default, the effort follows the name", () => {
    expect(modelLabel(claude, null, null)).toBe("Default");
    expect(modelLabel(claude, "opus", "high")).toBe("Opus 5 · high");
    expect(modelLabel([], "gpt-9", null)).toBe("gpt-9");
  });

  test("a saved full id finds the alias row of its lineage", () => {
    const listed = [
      model("default", { name: "Default (recommended)", isDefault: true }),
      model("opus", { name: "Opus 5.5" }),
      model("claude-opus-4-8", { name: "Opus 4.8" }),
      model("sonnet", { name: "Sonnet" }),
    ];

    expect(findModel(listed, "claude-opus-5-5")?.id).toBe("opus");
    expect(findModel(listed, "claude-opus-4-8")?.id).toBe("claude-opus-4-8");
    expect(findModel(listed, "claude-sonnet-5-5-20261001")?.id).toBe("sonnet");
    expect(modelLabel(listed, "claude-opus-5-5", "high")).toBe("Opus 5.5 · high");
  });

  test("a lineage that isn't listed, or is ambiguous, keeps the raw id", () => {
    const listed = [model("opus", { name: "Opus 5.5" }), model("opus-fast", { name: "Opus 5.5" })];

    expect(modelLabel(listed, "claude-opus-6", null)).toBe("claude-opus-6");
    expect(modelLabel(listed, "claude-opus-5-5", null)).toBe("claude-opus-5-5");
    expect(modelLabel(listed, "claude-haiku-5-5", null)).toBe("claude-haiku-5-5");
  });

  test("a new session starts on the Harness's default; Claude sends null", () => {
    expect(defaultChoice("claude", claude)).toBeNull();
    expect(defaultChoice("codex", [model("a"), model("b", { isDefault: true })])).toEqual({
      model: "b",
      effort: "medium",
    });
  });
});

describe("changing Model in a session", () => {
  const base = {
    switchesModel: true,
    canSetModel: true,
    canFork: true,
    turnInFlight: false,
    hasFinishedTurn: true,
  };

  test("between Turns, a switching Harness takes SetModel", () => {
    expect(modelChange(base)).toEqual({ kind: "set" });
  });

  test("mid-Turn, SetModel waits", () => {
    expect(modelChange({ ...base, turnInFlight: true }).kind).toBe("blocked");
  });

  test("a Harness that can't switch offers a Fork on the Model", () => {
    expect(modelChange({ ...base, switchesModel: false })).toEqual({ kind: "fork" });
    expect(modelChange({ ...base, canSetModel: false })).toEqual({ kind: "fork" });
  });

  test("nothing to fork from, or no fork: blocked with a reason", () => {
    expect(modelChange({ ...base, switchesModel: false, hasFinishedTurn: false }).kind).toBe(
      "blocked"
    );
    expect(modelChange({ ...base, switchesModel: false, canFork: false }).kind).toBe("blocked");
  });
});
