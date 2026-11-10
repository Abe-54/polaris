/**
 * The composer's prompt (R6): a Lexical editor whose `/` menu lists the
 * session's Harness's Skills and Slash Commands (`harness.commands`) and whose
 * `@` picker finds files; each becomes a chip. Mounted in `DraftComposer`.
 */
export { Prompt, preloadPrompt } from "./ui/Prompt.tsx";

export type { PromptEditorProps } from "./ui/PromptEditor.tsx";

export { type CommandOption, promptFor } from "./model/commands.ts";

export { sentMessages } from "./model/history.ts";

export { isShellDraft, leaveShell, shellCommandOf, shellDraft } from "./model/shell.ts";

export { useHarnessCommands } from "./live.ts";

export { useMentionSearch } from "./mentionSearch.ts";

export type { MentionSearch } from "./model/mentions.ts";

export { type CommandNotice, daemonNotice } from "./model/notice.ts";

export type { FrecencyTable } from "./model/frecency.ts";

export { type FrecencyScope, loadFrecency, recordFrecency, scopeKey } from "./frecencyStore.ts";

export { frecencyKey } from "./model/commands.ts";

export { SentText } from "./ui/SentText.tsx";

export { mayNameCommand } from "./model/sent.ts";

export { ensureCommands, useKnownCommands } from "./live.ts";
