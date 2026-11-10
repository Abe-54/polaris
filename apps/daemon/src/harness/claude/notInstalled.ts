/** Names the PATH searched, so a user can see where the Daemon looked (ENG-413). */
export const claudeNotFound = (): string =>
  `\`claude\` was not found on the Daemon's PATH (${process.env.PATH ?? ""})`;

export const claudeNotInstalled = (): string => `Claude Code is not installed: ${claudeNotFound()}`;
