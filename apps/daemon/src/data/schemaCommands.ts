/** Commands that may change a schema without producing a migration file or a Data query. */
export const knownSchemaCommand = (command: string) =>
  /\b(?:prisma\s+(?:db\s+push|migrate)|drizzle-kit\s+push|supabase\s+db\s+(?:reset|push)|(?:psql|mysql|pgcli)\b)/.test(
    command
  );
