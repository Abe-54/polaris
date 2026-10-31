/** Credential forms from the connection selected by the resolver. */
import { Redacted } from "effect";

/** Use the password actually selected for the driver, including PostgreSQL query overrides. */
export const knownFromConnection = (
  connection: import("./connection.ts").DataConnection,
  matchUrl: Redacted.Redacted<string>
) => {
  const value = Redacted.value(connection.password);
  const forms = new Set([value, encodeURIComponent(value)]);
  forms.add(
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
  );

  try {
    const url = new URL(Redacted.value(matchUrl));
    forms.add(url.password);
    const query = /[?&]password=([^&]*)/i.exec(Redacted.value(matchUrl));

    if (query !== null) forms.add(query[1]!);
  } catch {
    // Invalid targets are handled by the resolver.
  }

  for (const form of forms) forms.add(form.replace(/%[a-f\d]{2}/gi, (hex) => hex.toLowerCase()));

  return [matchUrl, ...[...forms].flatMap((value) => (value === "" ? [] : [Redacted.make(value)]))];
};
