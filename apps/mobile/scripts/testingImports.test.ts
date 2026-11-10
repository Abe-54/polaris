import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript-js";
import config from "../metro.config.mjs";
import { appDir } from "./hermesPaths.ts";

const TESTING = /\.testing(\.tsx?)?$/;

const isDevFlag = (node: ts.Node) => ts.isIdentifier(node) && node.text === "__DEV__";

const declaredName = (node: ts.Node): ts.Node | undefined => {
  const named =
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isParameter(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node);

  return named ? node.name : undefined;
};

/** An identifier the code reads, not one it declares, a property name or a JSX attribute. */
const isRead = (id: ts.Identifier): boolean => {
  const parent = id.parent;

  if (ts.isShorthandPropertyAssignment(parent)) return true;

  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id;

  if (ts.isBindingElement(parent)) return false;

  if (ts.isJsxAttribute(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return false;

  return declaredName(parent) !== id;
};

/** Stored in an object literal, as `...x`, `{ x }` or `{ key: x }`: undefined there throws nothing. */
const isStored = (id: ts.Identifier): boolean => {
  const parent = id.parent;

  return (
    ts.isSpreadAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === id)
  );
};

/** Identifiers read anywhere under `node`, function bodies included; types are skipped. */
const readsIn = (node: ts.Node, into = new Set<string>()): Set<string> => {
  if (ts.isTypeNode(node)) return into;

  if (ts.isIdentifier(node) && isRead(node)) into.add(node.text);

  ts.forEachChild(node, (child) => void readsIn(child, into));

  return into;
};

const isDevAnd = (node: ts.Node) =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
  isDevFlag(node.left);

/** Calls `visit` on the parts of `node` that run when the module loads. */
const visitLoadTime = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  if (ts.isFunctionLike(node) || ts.isClassElement(node) || ts.isTypeNode(node) || isDevAnd(node))
    return;

  // A `__DEV__` branch: a release bundle folds it away.
  if (ts.isIfStatement(node) && isDevFlag(node.expression)) {
    if (node.elseStatement !== undefined) visitLoadTime(node.elseStatement, visit);

    return;
  }

  if (ts.isConditionalExpression(node) && isDevFlag(node.condition)) {
    visitLoadTime(node.whenFalse, visit);

    return;
  }

  visit(node);
  ts.forEachChild(node, (child) => visitLoadTime(child, visit));
};

const importedNames = (clause: ts.ImportClause): Array<string> => {
  const bindings = clause.namedBindings;
  const names = clause.name === undefined ? [] : [clause.name.text];

  if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);

  if (bindings !== undefined && ts.isNamedImports(bindings))
    for (const element of bindings.elements) if (!element.isTypeOnly) names.push(element.name.text);

  return names;
};

const testingImports = (source: ts.SourceFile): Set<string> =>
  new Set(
    source.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        return [];

      const clause = statement.importClause;

      return clause === undefined ||
        clause.isTypeOnly ||
        !TESTING.test(statement.moduleSpecifier.text)
        ? []
        : importedNames(clause);
    })
  );

/** Top-level functions, `function f` and `const f = () => …`, with the names each reads. */
const topLevelFunctions = (source: ts.SourceFile): Array<readonly [string, Set<string>]> =>
  source.statements.flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      return [[statement.name.text, readsIn(statement)] as const];

    if (!ts.isVariableStatement(statement)) return [];

    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.initializer !== undefined &&
      ts.isFunctionLike(declaration.initializer)
        ? [[declaration.name.text, readsIn(declaration.initializer)] as const]
        : []
    );
  });

/** The testing imports, and every top-level function that reads one, directly or through another. */
const tainted = (source: ts.SourceFile): Set<string> => {
  const names = testingImports(source);
  const functions = topLevelFunctions(source);
  let grew = names.size > 0;

  while (grew) {
    const before = names.size;

    for (const [name, reads] of functions)
      if ([...reads].some((read) => names.has(read))) names.add(name);

    grew = names.size > before;
  }

  return names;
};

/** `file:line name` for each testing import (or function reading one) used when `file` loads. */
const loadTimeReads = (file: string, code: string): Array<string> => {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const names = tainted(source);
  const reads: Array<string> = [];

  const visit = (node: ts.Node) => {
    if (!ts.isIdentifier(node) || !names.has(node.text) || !isRead(node) || isStored(node)) return;

    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    reads.push(`${file}:${line} ${node.text}`);
  };

  for (const statement of source.statements)
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      visitLoadTime(statement, visit);

  return reads;
};

describe("*.testing.ts modules in a release bundle", () => {
  const resolveRequest = config.resolver?.resolveRequest;

  type Context = Parameters<NonNullable<typeof resolveRequest>>[0];

  const resolve = (dev: boolean, moduleName: string) =>
    // SAFETY: the rule reads only `dev` before it answers for a `*.testing` module.
    resolveRequest?.({ dev } as Context, moduleName, "ios");

  test("Metro resolves them to an empty module outside development", () => {
    expect(resolve(false, "./worstCase.testing.ts")).toEqual({ type: "empty" });
    expect(resolve(false, "../stats/fixtures.testing")).toEqual({ type: "empty" });
  });

  test("no app module reads one when it loads, so the empty module can't crash a release", async () => {
    const reads: Array<string> = [];

    for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan(appDir)) {
      if (/\.(test|testing)\.tsx?$/.test(file)) continue;

      const code = await Bun.file(join(appDir, file)).text();

      if (/\.testing(\.tsx?)?["']/.test(code)) reads.push(...loadTimeReads(file, code));
    }

    expect(reads).toEqual([]);
  });
});
