/**
 * The inline feature as Edit mode mounts it, lazily with the editor: the selection bar and
 * card in every editor, ⌘I and ⌘L, and vim's `:e` opening the ⌘P finder.
 */
import { useEffect } from "react";
import { openFileFinder } from "../editor-finder/index.ts";
import { setFileFinder } from "../editor/api.ts";
import { useInlineInstall } from "./install.ts";
import { InlineLayers } from "./ui/InlineLayers.tsx";

const Installed = () => {
  useInlineInstall();
  useEffect(() => {
    setFileFinder(openFileFinder);
  }, []);

  return <InlineLayers />;
};

export default Installed;
