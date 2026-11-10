/**
 * The built-in always-refused apps (ADR 0104), by stable id: the bundle id on macOS. They would
 * hand an agent a shell or the user's secrets, past the approvals its session asks for.
 */
import type { AppId } from "@polaris/protocol";

const TERMINALS = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.mitchellh.ghostty",
  "dev.warp.Warp-Stable",
  "dev.warp.Warp-Preview",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "io.alacritty",
  "com.github.wez.wezterm",
  "co.zeit.hyper",
  "org.tabby",
  "com.raphaelamorim.rio",
];

const SCRIPT_RUNNERS = [
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
  "com.apple.AppleScriptUtility",
];

const SECRETS = [
  "com.apple.systempreferences",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.lastpass.lastpassmacdesktop",
  "com.dashlane.dashlanephonefinal",
  "com.dashlane.Dashlane",
  "org.keepassxc.keepassxc",
  "me.proton.pass.electron",
  "com.nordpass.macos.beta",
  "in.sinew.Enpass-Desktop",
];

/** Where the Host gives an app no id but its name (Linux, Windows): the same apps, by that name. */
const BY_NAME = [
  "terminal",
  "gnome-terminal",
  "gnome-terminal-server",
  "org.gnome.terminal",
  "org.gnome.console",
  "kgx",
  "konsole",
  "org.kde.konsole",
  "xterm",
  "xfce4-terminal",
  "tilix",
  "foot",
  "kitty",
  "alacritty",
  "wezterm",
  "ghostty",
  "warp",
  "iterm2",
  "windows terminal",
  "windowsterminal.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "command prompt",
  "windows powershell",
  "powershell",
  "script editor",
  "automator",
  "shortcuts",
  "system settings",
  "settings",
  "gnome-control-center",
  "systemsettings",
  "keychain access",
  "passwords",
  "seahorse",
  "passwords and keys",
  "kwalletmanager",
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
  "keepassxc",
  "proton pass",
  "polaris",
  "polaris computer use",
];

const REFUSED = new Set(
  [...TERMINALS, ...SCRIPT_RUNNERS, ...SECRETS, ...BY_NAME].map((id) => id.toLowerCase())
);

/** Polaris itself, in every build: the Desktop App, the Daemon and the computer use helper. */
const POLARIS = "dev.lux.polaris";

export const builtInRefused = (appId: AppId): boolean => {
  const id = appId.trim().toLowerCase();

  return REFUSED.has(id) || id === POLARIS || id.startsWith(`${POLARIS}.`);
};
