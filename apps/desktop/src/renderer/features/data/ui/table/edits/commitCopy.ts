/**
 * A grid commit's failure in the user's words (DESIGN.md, Data: Table tab): by its E-DATA code,
 * naming the row when the Daemon says which. The Daemon's fixes are written for agents and stay
 * out of the footer.
 */
import type { IpcError } from "../../../../../../shared/api.ts";
import { cellOf, displayOf, type DataValue } from "../../../grid/value.ts";

export interface CommitCopy {
  /** What happened, after "Commit failed ·". */
  readonly message: string;
  /** What the user can do; the edits are always still staged. */
  readonly fix: string;
}

/** "id = 42", or "order_id = 7, line = 2" for a composite key. */
export const keyLabel = (names: ReadonlyArray<string>, key: ReadonlyArray<DataValue>) =>
  key.map((value, i) => `${names[i] ?? "key"} = ${displayOf(cellOf(value))}`).join(", ");

const BY_CODE = new Map(
  Object.entries({
    "E-DATA-DENIED": {
      message: "Writes aren't allowed on this data source now",
      fix: "Allow writes in Connection…, then commit again.",
    },
    "E-DATA-READ-ONLY": {
      message: "The database only allows reads on this connection",
      fix: "Connect as a user who can write, then commit again.",
    },
    "E-DATA-TIMEOUT": {
      message: "The commit took too long and was rolled back",
      fix: "Commit fewer changes at a time, or try again when the database is less busy.",
    },
    "E-DATA-UNREACHABLE": {
      message: "The database couldn't be reached",
      fix: "Check the connection in Connection…, then commit again.",
    },
    "E-DATA-CANCELLED": {
      message: "The commit was cancelled and nothing was written",
      fix: "Commit again when you're ready.",
    },
    "E-DATA-OUTCOME-UNKNOWN": {
      message: "The connection dropped before the database confirmed the commit",
      fix: "Reload the table to see whether the changes landed; a new commit checks them first.",
    },
    "E-DATA-UNKNOWN-SOURCE": {
      message: "This data source is no longer in the checkout",
      fix: "Add it again in Data, then commit.",
    },
    Unsupported: {
      message: "This Host can't write data yet",
      fix: "Upgrade the Daemon on this Host to commit edits.",
    },
  } satisfies Readonly<Record<string, CommitCopy>>)
);

const REFUSED: CommitCopy = {
  message: "The database refused the change",
  fix: "Correct the value or drop the edit, then commit again.",
};

/** The footer's words for a failed commit; a database's own reason is kept as it said it. */
export const commitCopy = (error: IpcError, keyNames: ReadonlyArray<string>): CommitCopy => {
  const known = BY_CODE.get(error.code);

  if (known !== undefined) return known;
  const row = error.row === undefined ? "" : ` on ${keyLabel(keyNames, error.row)}`;

  if (error.code === "E-DATA-SQL")
    return { message: `${REFUSED.message}${row}: ${error.message}`, fix: REFUSED.fix };

  return {
    message: `Polaris couldn't reach the Host: ${error.message}`,
    fix: "Commit again once the Host is connected.",
  };
};
