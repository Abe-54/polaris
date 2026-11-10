/**
 * Warms the Editor before the user arrives (QCHECK: an 827 ms cold first open):
 * Edit mode's chunk and the grammars of the tabs it will show. Runs when the
 * pointer or focus reaches the mode switch; the grammars never load at idle,
 * though the chunk does with the other modes' (app/warmModes.ts, ENG-905).
 */
import { loadLanguage } from "./cm/languages.ts";
import { readTabs } from "./model/drafts.ts";
import { languageFor } from "./model/language.ts";

let warmed = false;

export const preloadEditor = () => {
  if (warmed) return;
  warmed = true;
  void import("./explorer/ui/EditMode.tsx");

  try {
    for (const set of Object.values(readTabs(globalThis.localStorage))) {
      if (set.active !== null) void loadLanguage(languageFor(set.active));
    }
  } catch {
    // No storage: Edit mode's chunk still loads; grammars load with their files.
  }
};
