// Expo's defaults find the Bun workspace root; `@polaris/sdk` resolves to its browser build,
// and `sodium-universal` to the native libsodium module (src/sodium/universal.ts).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import expoMetroConfig from "expo/metro-config";

const config = expoMetroConfig.getDefaultConfig(import.meta.dirname);

const sodium = fileURLToPath(new URL("src/sodium/universal.ts", import.meta.url));

// Token imports resolve to src/theme/fonts.ts: the same tokens, with each platform's font families.
const mobileTokens = fileURLToPath(new URL("src/theme/fonts.ts", import.meta.url));

// Pierre's index pulls in Shiki and the DOM renderer; the app only parses patches (src/review/patch.ts).
const pierreParser = join(
  dirname(fileURLToPath(import.meta.resolve("@pierre/diffs"))),
  "utils",
  "parsePatchFiles.js"
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "sodium-universal") return { type: "sourceFile", filePath: sodium };

  if (moduleName === "@polaris/ui/tokens") return { type: "sourceFile", filePath: mobileTokens };

  if (moduleName === "@pierre/diffs") return { type: "sourceFile", filePath: pierreParser };

  return context.resolveRequest(
    moduleName === "@polaris/sdk"
      ? { ...context, unstable_conditionNames: [...context.unstable_conditionNames, "browser"] }
      : context,
    moduleName,
    platform
  );
};

export default config;
