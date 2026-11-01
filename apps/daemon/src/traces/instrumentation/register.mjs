const guard = Symbol.for("polaris.node-instrumentation.register");

// No loader thread, manifest reads or SDK parsing when this child has no receiver.
if (!process.versions.bun && process.env.POLARIS_OTEL_ENDPOINT && !Reflect.has(globalThis, guard)) {
  Reflect.set(globalThis, guard, true);

  try {
    const { appOwnsTelemetry } = await import("./ownership.mjs");

    if (!appOwnsTelemetry()) {
      const { register, createRequire } = await import("node:module");
      register(new URL("./hook.mjs", import.meta.url));
      createRequire(import.meta.url)("./sdk.cjs");
    }
  } catch {
    // Optional tracing must not prevent application startup.
  }
}
