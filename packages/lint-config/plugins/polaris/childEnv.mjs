// polaris/child-env: every Daemon child launch passes `env:` from childEnv or a builder on it (ENG-269).
// Bun's default spawn env still holds POLARIS_HANDOFF after the Daemon deletes it.
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import { CHILD_ENV } from "./childEnvAllowlist.mjs";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const EXEMPT = [
  /\.(test|testing|fixture|bench|smoke)\.[cm]?[jt]sx?$/,
  /(^|\/)testing(\.[cm]?[jt]sx?$|\/)/,
];

const CHILD_PROCESS = new Set(["node:child_process", "child_process"]);
const LAUNCHERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
const BUN_LAUNCHERS = new Set(["spawn", "spawnSync"]);
const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";

const MESSAGE =
  "A Daemon child launch passes `env: childEnv(…)` (or a builder over it, such as harnessEnv): " +
  "Bun's default env still carries POLARIS_HANDOFF. Add a justified exception to childEnvAllowlist.mjs.";

const OPTIONS = [
  {
    type: "object",
    properties: {
      scope: { type: "array", items: { type: "string" } },
      allow: { type: "object", additionalProperties: { type: "string" } },
      builders: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
];

const keyName = (property) =>
  property.key?.type === "Identifier" ? property.key.name : (property.key?.value ?? null);

const memberOf = (callee, object, names) =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.object.type === "Identifier" &&
  callee.object.name === object &&
  names.has(callee.property.name);

/** Whether the rule checks this file: in scope, not a test, not allowlisted. */
const checks = (context) => {
  const config = { ...CHILD_ENV, ...context.options[0] };
  const path = relative(ROOT, context.filename).split(sep).join("/");
  const inScope = config.scope.some((prefix) => path.startsWith(prefix));
  const allowed = Object.keys(config.allow).some((prefix) => path.startsWith(prefix));

  return { config, checked: inScope && !allowed && !EXEMPT.some((p) => p.test(path)) };
};

/** Tracks imports and file-level consts so a launch's options and env can be followed. */
const fileFacts = () => ({
  launchers: new Set(),
  namespaces: new Set(),
  sdkOptions: new Set(),
  consts: new Map(),
});

const collectImport = (facts, node) => {
  const source = node.source.value;

  for (const specifier of node.specifiers) {
    if (CHILD_PROCESS.has(source) && specifier.type === "ImportNamespaceSpecifier")
      facts.namespaces.add(specifier.local.name);

    if (CHILD_PROCESS.has(source) && specifier.type === "ImportDefaultSpecifier")
      facts.namespaces.add(specifier.local.name);

    if (specifier.type !== "ImportSpecifier") continue;

    if (CHILD_PROCESS.has(source) && LAUNCHERS.has(specifier.imported.name))
      facts.launchers.add(specifier.local.name);

    if (source === CLAUDE_SDK && specifier.imported.name === "Options")
      facts.sdkOptions.add(specifier.local.name);
  }
};

const isLaunch = (facts, callee) =>
  (callee.type === "Identifier" && facts.launchers.has(callee.name)) ||
  memberOf(callee, "Bun", BUN_LAUNCHERS) ||
  (callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    facts.namespaces.has(callee.object.name) &&
    memberOf(callee, callee.object.name, LAUNCHERS));

/** Follows an identifier to its file-level const initializer, once. */
const resolve = (facts, node) =>
  node?.type === "Identifier" && facts.consts.has(node.name) ? facts.consts.get(node.name) : node;

const unwrap = (node) =>
  node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression"
    ? unwrap(node.expression)
    : node;

/** Whether an env value comes from a builder: `childEnv(…)`, a const of one, or a choice of them. */
const isBuilt = (facts, builders, node, depth = 0) => {
  const value = unwrap(depth < 4 ? resolve(facts, node) : node);

  if (value?.type === "CallExpression")
    return value.callee.type === "Identifier" && builders.has(value.callee.name);

  if (value?.type === "ConditionalExpression")
    return (
      isBuilt(facts, builders, value.consequent, depth + 1) &&
      isBuilt(facts, builders, value.alternate, depth + 1)
    );

  if (value?.type === "AwaitExpression") return isBuilt(facts, builders, value.argument, depth + 1);

  // A literal env inherits nothing; its spreads must be built ones.
  if (value?.type === "ObjectExpression")
    return value.properties.every(
      (p) => p.type === "Property" || isBuilt(facts, builders, p.argument, depth + 1)
    );

  return false;
};

/** The launch's options object: a literal argument, or a const one. */
const optionsOf = (facts, call) =>
  call.arguments
    .map((argument) => unwrap(resolve(facts, argument)))
    .find((argument) => argument?.type === "ObjectExpression");

/** The options' `env`, also through a spread const (`{ ...spawnOptions, … }`); last one wins. */
const envOf = (facts, options, depth = 0) => {
  let env;

  for (const property of options?.properties ?? []) {
    if (property.type === "Property" && keyName(property) === "env") env = property.value;

    const spread = property.type === "SpreadElement" && unwrap(resolve(facts, property.argument));

    if (spread?.type === "ObjectExpression" && depth < 4)
      env = envOf(facts, spread, depth + 1) ?? env;
  }

  return env;
};

const isSdkOptions = (facts, annotation) => {
  const type = annotation?.typeAnnotation;

  return (
    type?.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    facts.sdkOptions.has(type.typeName.name)
  );
};

export const childEnvRule = {
  meta: {
    type: "problem",
    schema: OPTIONS,
    docs: { description: "Daemon child launches pass an explicit env from childEnv." },
  },
  create(context) {
    const { config, checked } = checks(context);

    if (!checked) return {};

    const builders = new Set(config.builders);
    const facts = fileFacts();
    const launches = [];
    const sdk = [];

    return {
      ImportDeclaration(node) {
        collectImport(facts, node);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) facts.consts.set(node.id.name, node.init);

        if (node.id.type === "Identifier" && node.init?.type === "ObjectExpression")
          sdk.push({ node: node.init, annotation: node.id.typeAnnotation });
      },
      CallExpression(node) {
        launches.push(node);
      },
      "Program:exit"() {
        for (const call of launches) {
          if (!isLaunch(facts, call.callee)) continue;

          if (!isBuilt(facts, builders, envOf(facts, optionsOf(facts, call))))
            context.report({ node: call, message: MESSAGE });
        }

        for (const { node, annotation } of sdk) {
          if (isSdkOptions(facts, annotation) && !isBuilt(facts, builders, envOf(facts, node)))
            context.report({ node, message: MESSAGE });
        }
      },
    };
  },
};
