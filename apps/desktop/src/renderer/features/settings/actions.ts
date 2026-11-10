/** Settings' commands (`shared/keymapSettings.ts`): "Settings…" (⌘,) and one per section, for the K menu. */
import type { CommandHandlers } from "../../routes/commands.ts";
import { checkForUpdates, restartToUpdate, updatesStore } from "./updates/store.ts";
import type { ShellActions } from "../../routes/navigation.ts";

export const settingsCommands = (shell: ShellActions): CommandHandlers => ({
  "settings.about": { run: () => shell.openSettings("about") },
  "updates.check": {
    run: () => {
      shell.openSettings("about");
      void checkForUpdates();
    },
  },
  "updates.restart": {
    run: () => void restartToUpdate(),
    enabled: () => updatesStore.getState().view?.phase === "ready",
  },
  "settings.open": { run: () => shell.openSettings() },
  "settings.appearance": { run: () => shell.openSettings("appearance") },
  "settings.sessions": { run: () => shell.openSettings("sessions") },
  "settings.editor": { run: () => shell.openSettings("editor") },
  "settings.harnesses": { run: () => shell.openSettings("harnesses") },
  "settings.constellations": { run: () => shell.openSettings("constellations") },
  "settings.usage": { run: () => shell.openSettings("usage") },
  "settings.hosts": { run: () => shell.openSettings("hosts") },
  "settings.reviewer": { run: () => shell.openSettings("reviewer") },
  "settings.github": { run: () => shell.openSettings("github") },
  "settings.voice": { run: () => shell.openSettings("voice") },
  "settings.attachments": { run: () => shell.openSettings("attachments") },
  "github.addAccount": { run: () => shell.openSettings("github", { adding: true }) },
});
