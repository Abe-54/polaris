/**
 * A sent message as the composer showed it: Skills, Slash Commands and file
 * mentions as chips (`../model/sent.ts`), the rest as text. The sigil is kept
 * as hidden text, so copying the message and screen readers get `/name`.
 */
import { ICON_MASKS } from "@polaris/ui";
import { type CSSProperties, Fragment, type ReactNode } from "react";
import type { CommandOption } from "../model/commands.ts";
import { sentPieces } from "../model/sent.ts";
import "./chip.css";

export interface SentTextProps {
  readonly text: string;
  /** The Harness's commands where it ran; none leaves commands as text. */
  readonly commands: ReadonlyArray<CommandOption>;
  /** Draws a run of plain text (the conversation breaks long runs). */
  readonly wrap: (text: string) => ReactNode;
}

export const SentText = ({ text, commands, wrap }: SentTextProps) =>
  sentPieces(text, commands).map((piece, n) =>
    piece.kind === "text" ? (
      <Fragment key={n}>{wrap(piece.text)}</Fragment>
    ) : (
      <span
        key={n}
        className="composer-chip"
        data-sent=""
        data-kind={piece.chip}
        data-testid="sent-chip"
        // SAFETY: React passes custom properties through `style`; its type only lacks the name.
        style={{ "--chip-icon": ICON_MASKS[piece.chip] } as CSSProperties}
      >
        <span className="sr-only">{piece.sigil}</span>
        {piece.name}
      </span>
    )
  );
