import { describe, expect, test } from "bun:test";
import { measuredStates } from "./diagnostics.testing.ts";
import { verifyDiagnostics, type BufferDiagnostic, type DiagnosticsCheck } from "./diagnostics.ts";

const suppressed = (check: DiagnosticsCheck) => !verifyDiagnostics(check).allow;

describe("the diagnostics verifier on every measured state", () => {
  test("never suppresses a ground truth or a useful prediction", () => {
    const lost = measuredStates
      .filter((state) => state.label === "exact" || state.label === "acceptable")
      .filter((state) => suppressed(state.check))
      .map((state) => state.id);

    expect(lost).toEqual([]);
  });

  test.each([
    ["hrf07", "an added type error"],
    ["hin12", "a syntax error"],
    ["fim12", "a local stand-in for an importable helper"],
    ["him01", "a local stand-in for an importable interface"],
    ["im03", "a local stand-in for an importable function"],
  ])("suppresses dangerous %s: %s", (id) => {
    const dangerous = measuredStates.filter((s) => s.id === id && s.label === "dangerous");

    expect(dangerous.length).toBeGreaterThan(0);
    expect(dangerous.some((state) => suppressed(state.check))).toBe(true);
  });

  test("suppresses most wrong predictions", () => {
    const wrong = measuredStates.filter((state) => state.label === "wrong");

    expect(wrong.filter((state) => suppressed(state.check)).length * 2).toBeGreaterThan(
      wrong.length
    );
  });

  test("the stand-in rule needs the server's import fixes", () => {
    const fim12 = measuredStates.find((s) => s.id === "fim12" && s.label === "dangerous");

    expect(fim12 && suppressed({ ...fim12.check, importable: [] })).toBe(false);
  });
});

const error = (buffer: string, name: string, at = buffer.indexOf(name)): BufferDiagnostic => ({
  from: at,
  to: at + name.length,
  severity: "error",
  code: "2304",
  message: `Cannot find name '${name}'.`,
});

describe("matching errors before and after", () => {
  const buffer = "const a = missing;\n";

  test("an error the edit only moves is not new", () => {
    const after = `// note\n${buffer}`;

    expect(
      verifyDiagnostics({
        buffer,
        edits: [{ from: 0, to: 0, text: "// note\n" }],
        before: [error(buffer, "missing")],
        after: [error(after, "missing")],
      }).allow
    ).toBe(true);
  });

  test("a second copy of the user's own error is new", () => {
    const after = `${buffer}const b = missing;\n`;

    expect(
      verifyDiagnostics({
        buffer,
        edits: [{ from: buffer.length, to: buffer.length, text: "const b = missing;\n" }],
        before: [error(buffer, "missing")],
        after: [error(after, "missing"), error(after, "missing", after.lastIndexOf("missing"))],
      }).allow
    ).toBe(false);
  });
});

describe("standing in for an importable name", () => {
  const buffer = 'import { a } from "./a.ts";\n\nhelper();\n';
  const before = [error(buffer, "helper")];
  const at = (text: string) => ({ from: buffer.length, to: buffer.length, text });

  test("declaring it locally is suppressed", () => {
    const edits = [at("function helper() {}\n")];

    expect(verifyDiagnostics({ buffer, edits, before, after: [], importable: before })).toEqual({
      allow: false,
      reason: "diagnostics",
      introduced: [],
      shadowed: before,
    });
  });

  test.each([
    ["importing it", { from: 0, to: 0, text: 'import { helper } from "./helper.ts";\n' }],
    [
      "renaming the reference",
      {
        from: buffer.indexOf("helper"),
        to: buffer.indexOf("helper") + "helper".length,
        text: "a",
      },
    ],
  ])("%s is allowed", (_, edit) => {
    expect(
      verifyDiagnostics({ buffer, edits: [edit], before, after: [], importable: before }).allow
    ).toBe(true);
  });

  test("finishing the declaration the user is typing is allowed", () => {
    const typing = `${buffer}function hel`;
    const edits = [{ from: typing.length, to: typing.length, text: "per() {}\n" }];

    expect(
      verifyDiagnostics({
        buffer: typing,
        cursor: typing.length,
        edits,
        before: [error(typing, "helper")],
        after: [],
        importable: [error(typing, "helper")],
      }).allow
    ).toBe(true);
  });
});
