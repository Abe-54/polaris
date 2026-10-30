/**
 * The SQL tab's language: lang-sql in the Data Source's dialect, completing its tables and
 * columns from the catalog (ENG-649), per tab. Formatting is sql-formatter, loaded on first use.
 */
import { MySQL, PostgreSQL, type SQLConfig, sql } from "@codemirror/lang-sql";
import type { LanguageSupport } from "@codemirror/language";
import type { DataSource } from "@polaris/protocol";
import { type Catalog, sqlNamespace } from "./catalog.ts";

export type Engine = DataSource["engine"];

export const sqlLanguage = (engine: Engine, catalog: Catalog | null): LanguageSupport => {
  const config: SQLConfig = { dialect: engine === "mysql" ? MySQL : PostgreSQL };

  if (catalog !== null) config.schema = sqlNamespace(catalog);

  if (catalog?.defaultSchema != null) config.defaultSchema = catalog.defaultSchema;

  return sql(config);
};

export type Formatted =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/** The query laid out by sql-formatter in the source's dialect, or why it couldn't parse it. */
export const formatSql = async (text: string, engine: Engine): Promise<Formatted> => {
  const { format } = await import("sql-formatter");

  try {
    return {
      ok: true,
      text: format(text, { language: engine === "mysql" ? "mysql" : "postgresql", tabWidth: 2 }),
    };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
};
