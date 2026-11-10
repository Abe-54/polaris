/**
 * The Hermes test's entry: the self-check on the bare VM, and the VM's builtin methods, each
 * printed on one line for `scripts/hermes.ts` to read. Bundled into one script; never in the app.
 */
import "./vmHost.ts";
import { builtinSurface } from "./builtinSurface.ts";
import { runSelfCheck } from "./selfCheck.ts";

// scripts/hermes.ts reads these markers.
console.log(`POLARIS_BUILTINS ${JSON.stringify(builtinSurface())}`);

void runSelfCheck().then((results) => console.log(`POLARIS_SELF_CHECK ${JSON.stringify(results)}`));
