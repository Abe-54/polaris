// polaris/no-ptr-argument: `ptr(…)` is never a direct call argument (ENG-342).
// See docs/adr/0066-ffi-buffers-are-passed-as-typed-arrays.md.

/** Calls that only turn an address into a number to store it; they keep nothing alive either. */
const CONVERSIONS = new Set(["BigInt", "Number"]);

const MESSAGE =
  "ptr() roots nothing: the buffer can be collected before this call reads it (ADR 0066). " +
  "Pass the typed array itself (a subarray or a view for an offset); store a ptr() only where " +
  "a later call keeps its memory alive.";

/** Unwraps `x as T`, `x!` and `x satisfies T`, which don't change what is passed. */
const unwrap = (node) =>
  node.type === "TSAsExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSSatisfiesExpression"
    ? unwrap(node.expression)
    : node;

export const noPtrArgument = {
  meta: {
    type: "problem",
    docs: { description: "Pass typed arrays to bun:ffi calls, never `ptr(…)` as an argument." },
  },
  create(context) {
    const named = new Set();
    const namespaces = new Set();

    const isPtr = (callee) => {
      if (callee.type === "Identifier") return named.has(callee.name);

      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        callee.property.name === "ptr"
      );
    };

    const isConversion = (callee) => callee.type === "Identifier" && CONVERSIONS.has(callee.name);

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "bun:ffi") return;

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);

          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "ptr")
            named.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        if (isConversion(node.callee)) return;

        for (const argument of node.arguments) {
          const value = unwrap(argument);

          if (value.type === "CallExpression" && isPtr(value.callee))
            context.report({ node: value, message: MESSAGE });
        }
      },
    };
  },
};
