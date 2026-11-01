/** Compose Node preloads without replacing the user's options or interpreting shell syntax. */
export const appendNodeImport = (options: string | undefined, path: string): string =>
  `${options?.trim() ?? ""} --import ${JSON.stringify(path)}`.trim();
