// polaris/no-fixed-sleep: a test waits on a condition or TestClock, not on wall-clock time.
// See packages/lint-config/README.md.

const MAX_SLEEP_MS = 50;

const TEST_FILES = [/\.(test|testing)\.[cm]?[jt]sx?$/, /(^|\/)testing(\.[cm]?[jt]sx?$|\/)/];

const SLEEP_HELPERS = new Set(["sleep", "delay", "setTimeout"]);

const MS_PER_UNIT = {
  nano: 1e-6,
  micro: 1e-3,
  milli: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const DURATION_CTORS = {
  millis: "milli",
  seconds: "second",
  minutes: "minute",
  hours: "hour",
  days: "day",
  weeks: "week",
};

const DURATION_TEXT = /^(\d+(?:\.\d+)?)\s+(nano|micro|milli|second|minute|hour|day|week)s?$/;

const RACES = {
  Promise: new Set(["race", "any"]),
  Effect: new Set(["race", "raceAll", "raceFirst"]),
};

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** Helpers wrapping helpers end here; a recursive helper can't loop the rule. */
const MAX_DEPTH = 4;

const message = (ms) =>
  `A fixed ${ms} ms sleep in a test (the limit is ${MAX_SLEEP_MS} ms) is slow when it's long ` +
  "enough and flaky when it isn't. Wait on a condition (poll, an event, a Deferred), or use " +
  "TestClock for time the code under test measures.";

const isMember = (node, object, property) =>
  node.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === object &&
  node.property.type === "Identifier" &&
  node.property.name === property;

/** The `const` or function a name is bound to here, or null. */
function bindingOf(name, scope) {
  for (let at = scope; at !== null; at = at.upper) {
    const definition = at.set.get(name)?.defs[0];

    if (definition === undefined) continue;

    if (definition.type === "FunctionName") return definition.node;

    if (definition.type === "Variable" && definition.parent.kind === "const") {
      return definition.node.init;
    }

    return null;
  }

  return null;
}

/** The milliseconds of a duration string, or null. */
function textMs(text) {
  const match = DURATION_TEXT.exec(text);

  return match === null ? null : Number(match[1]) * MS_PER_UNIT[match[2]];
}

function literalMs(node) {
  if (typeof node.value === "number") return node.value;

  return typeof node.value === "string" ? textMs(node.value) : null;
}

/** `Duration.seconds(2)` and friends. */
function durationCallMs(node, scope, depth) {
  const { callee } = node;

  if (callee.type !== "MemberExpression" || callee.object.name !== "Duration") return null;

  const amount = node.arguments[0] && durationMs(node.arguments[0], scope, depth);
  const unit = DURATION_CTORS[callee.property.name];

  return typeof amount === "number" && unit !== undefined ? amount * MS_PER_UNIT[unit] : null;
}

function binaryMs(node, scope, depth) {
  const left = durationMs(node.left, scope, depth);
  const right = durationMs(node.right, scope, depth);

  if (left === null || right === null) return null;

  if (node.operator === "*") return left * right;

  return node.operator === "+" ? left + right : null;
}

/** The longest fixed duration a node can be: `win32 ? 500 : 100` is 500. */
function conditionalMs(node, scope, depth) {
  const options = [node.consequent, node.alternate].flatMap((option) => {
    const ms = durationMs(option, scope, depth);

    return ms === null ? [] : [ms];
  });

  return options.length === 0 ? null : Math.max(...options);
}

/** The milliseconds a literal or constant duration comes to; null when it isn't fixed. */
function durationMs(node, scope, depth = 0) {
  if (depth > MAX_DEPTH) return null;

  switch (node.type) {
    case "Literal":
      return literalMs(node);
    case "TemplateLiteral":
      return node.expressions.length === 0 ? textMs(node.quasis[0].value.cooked) : null;
    case "Identifier": {
      const bound = bindingOf(node.name, scope);

      return bound ? durationMs(bound, scope, depth + 1) : null;
    }
    case "BinaryExpression":
      return binaryMs(node, scope, depth + 1);
    case "ConditionalExpression":
      return conditionalMs(node, scope, depth + 1);
    case "CallExpression":
      return durationCallMs(node, scope, depth + 1);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return durationMs(node.expression, scope, depth + 1);
    default:
      return null;
  }
}

/** The one expression a function or block runs: `x`, `{ x; }`, `{ return x; }`, `{ await x; }`. */
function onlyExpression(body) {
  let node = body;

  if (node.type === "BlockStatement") {
    if (node.body.length !== 1) return null;

    node = node.body[0].type === "ExpressionStatement" ? node.body[0].expression : node.body[0];

    if (node.type === "ReturnStatement") node = node.argument;
  }

  return node?.type === "AwaitExpression" ? node.argument : (node ?? null);
}

function isResolver(node, resolve) {
  if (node.type === "Identifier") return node.name === resolve;

  if (!FUNCTIONS.has(node.type)) return false;

  const call = onlyExpression(node.body);

  return call?.type === "CallExpression" && call.callee.name === resolve;
}

/** The delay of `new Promise((r) => setTimeout(r, n))`; a timer that rejects isn't a sleep. */
function promiseSleepArgument(node) {
  const executor = node.arguments[0];

  if (node.callee.name !== "Promise" || !FUNCTIONS.has(executor?.type)) return null;

  const resolve = executor.params[0]?.name;
  const timer = onlyExpression(executor.body);

  if (resolve === undefined || timer?.type !== "CallExpression") return null;

  const isTimer =
    timer.callee.name === "setTimeout" || isMember(timer.callee, "globalThis", "setTimeout");

  if (!isTimer || timer.arguments.length < 2 || !isResolver(timer.arguments[0], resolve)) {
    return null;
  }

  return timer.arguments[1];
}

/** A local `(ms) => Bun.sleep(ms)`: what a call to it sleeps on, whatever its name. */
function helperSleep(node, scope, depth) {
  const helper = node.callee.type === "Identifier" ? bindingOf(node.callee.name, scope) : null;

  if (depth > MAX_DEPTH || !FUNCTIONS.has(helper?.type)) return null;

  const param = helper.params[0]?.name;
  const inner = param === undefined ? null : onlyExpression(helper.body);
  const sleep = inner === null ? null : sleepOf(inner, scope, depth + 1);

  if (sleep?.argument.type !== "Identifier" || sleep.argument.name !== param) return null;

  return { argument: node.arguments[0], virtual: sleep.virtual };
}

/** What a node sleeps on: its duration argument, and whether TestClock can drive it. */
function sleepOf(node, scope, depth = 0) {
  if (node.type === "NewExpression") {
    const argument = promiseSleepArgument(node);

    return argument === null ? null : { argument, virtual: false };
  }

  if (node.type !== "CallExpression") return null;

  const { callee } = node;
  const [first] = node.arguments;

  if (isMember(callee, "Effect", "sleep")) return { argument: first, virtual: true };

  if (isMember(callee, "Bun", "sleep") || isMember(callee, "Bun", "sleepSync")) {
    return { argument: first, virtual: false };
  }

  const helper = helperSleep(node, scope, depth);

  if (helper !== null) return helper;

  return callee.type === "Identifier" && SLEEP_HELPERS.has(callee.name)
    ? { argument: first, virtual: false }
    : null;
}

/** Whether the sleep is one side of a race: there it bounds a wait rather than being one. */
function isRaced(node) {
  for (let at = node.parent; at !== null && at !== undefined; at = at.parent) {
    if (FUNCTIONS.has(at.type)) return false;

    if (at.type === "CallExpression" && at.callee.type === "MemberExpression") {
      const races = RACES[at.callee.object.name];

      if (races?.has(at.callee.property.name)) return true;
    }
  }

  return false;
}

/** Whether the file imports TestClock, whose fibers' `Effect.sleep` is virtual time. */
const usesTestClock = (program) =>
  program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.specifiers.some((specifier) => specifier.local.name === "TestClock")
  );

export const noFixedSleep = {
  meta: {
    type: "suggestion",
    docs: {
      description: `No fixed sleeps over ${MAX_SLEEP_MS} ms in tests: wait on a condition or use TestClock.`,
    },
  },
  create(context) {
    const path = context.filename.replaceAll("\\", "/");

    if (!TEST_FILES.some((pattern) => pattern.test(path))) return {};

    let testClock = false;

    const check = (node) => {
      const scope = context.sourceCode.getScope(node);
      const sleep = sleepOf(node, scope);

      if (!sleep?.argument || (sleep.virtual && testClock)) return;

      const ms = durationMs(sleep.argument, scope);

      if (ms !== null && ms > MAX_SLEEP_MS && !isRaced(node)) {
        context.report({ node, message: message(ms) });
      }
    };

    return {
      Program(node) {
        testClock = usesTestClock(node);
      },
      CallExpression: check,
      NewExpression: check,
    };
  },
};
