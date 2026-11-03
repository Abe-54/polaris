import { withGradleProperties, withProjectBuildGradle } from "expo/config-plugins";

export default function withWindowsNativeBuild(config) {
  if (process.platform === "win32") {
    config = withGradleProperties(config, (config) => {
      const properties = new Map([
        ["org.gradle.workers.max", "2"],
        ["reactNativeArchitectures", "arm64-v8a,x86_64"],
      ]);

      config.modResults = config.modResults.filter(
        (entry) => entry.type !== "property" || !properties.has(entry.key)
      );

      for (const [key, value] of properties) {
        config.modResults.push({ type: "property", key, value });
      }

      return config;
    });
  }

  return withProjectBuildGradle(config, (config) => {
    const applyScript = 'apply from: new File(rootDir, "../plugins/windows-native-build.gradle")';
    const rootPlugin = 'apply plugin: "expo-root-project"';

    if (!config.modResults.contents.includes(applyScript)) {
      config.modResults.contents = config.modResults.contents.replace(
        rootPlugin,
        `${applyScript}\n\n${rootPlugin}`
      );
    }

    return config;
  });
}
