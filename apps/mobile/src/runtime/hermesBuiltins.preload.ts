/**
 * Test preload: Bun loses the builtins the app's Hermes lacks (`hermesMissing.json`, measured
 * by `bun run hermes`), so an app test that reaches one fails as the app would (ENG-591).
 */
import { removeBuiltins } from "./builtinSurface.ts";
import missing from "./hermesMissing.json" with { type: "json" };

removeBuiltins(missing);
