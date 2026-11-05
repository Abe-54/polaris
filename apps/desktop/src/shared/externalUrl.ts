/** Absolute web URLs the Desktop App may hand to the user's browser. */
export const externalUrl = (value: string): string | null => {
  if (
    !/^https?:\/\//i.test(value) ||
    /\s|\\/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return null;

  try {
    const url = new URL(value);

    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
};
