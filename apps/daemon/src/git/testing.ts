/** Test helpers: throwaway git repositories. Not used at runtime. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../platform/tempDir.testing.ts";
import { gitText } from "./git.ts";

export {
  removeTempDir,
  removeTempDirSettled,
  suiteTempDir,
  tempDir,
} from "../platform/tempDir.testing.ts";

export const write = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

/** A repository with an identity set and one commit containing `files`. */
export const makeRepo = async (files: Record<string, string> = { "README.md": "hello\n" }) => {
  const root = tempDir("polaris-repo-");
  await gitText(root, ["init", "-q", "-b", "main"]);
  // One write, not several `git config` calls: each changes the config, so the next call lists it
  // again. autocrlf off: Git for Windows (and its CI runners) turn it on, rewriting checkouts as CRLF.
  appendFileSync(
    join(root, ".git/config"),
    "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n" +
      "[core]\n\tautocrlf = false\n"
  );

  for (const [path, content] of Object.entries(files)) write(root, path, content);

  if (Object.keys(files).length > 0) {
    await gitText(root, ["add", "-A"]);
    await gitText(root, ["commit", "-q", "-m", "initial"]);
  }

  return root;
};

export const commitAll = async (root: string, message: string): Promise<string> => {
  await gitText(root, ["add", "-A"]);
  await gitText(root, ["commit", "-q", "-m", message]);

  return gitText(root, ["rev-parse", "HEAD"]);
};
