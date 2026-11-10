/**
 * The Editor's explorer, Edit mode's layout, and the git gutter (M3-EXPLORER;
 * DESIGN.md Editor, spec §4–§5). The interface for the shell and other features.
 */
export { EditMode, editChunk } from "./ui/LazyEditMode.tsx";

export { revealInExplorer, type RevealTarget } from "./data/reveal.ts";
