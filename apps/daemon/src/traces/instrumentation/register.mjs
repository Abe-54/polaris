import { register, createRequire } from "node:module";

// Bun must never register a Node provider, including when it inherits NODE_OPTIONS.
if (!process.versions.bun) {
  try {
    register(new URL("./hook.mjs", import.meta.url));
    createRequire(import.meta.url)("./sdk.cjs");
  } catch {
    // Optional tracing must not prevent application startup.
  }
}
