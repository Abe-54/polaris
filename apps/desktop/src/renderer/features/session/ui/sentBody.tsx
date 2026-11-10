/**
 * A sent message's text in the conversation: the composer's chips for its
 * Skills, Slash Commands and file mentions, with long runs broken (`softWrap`).
 */
import type { Harness } from "@polaris/ui";
import { useEffect } from "react";
import {
  ensureCommands,
  mayNameCommand,
  SentText,
  useKnownCommands,
} from "../../composer/index.ts";
import { hasCapability, useHost } from "../hooks.ts";
import { softWrap } from "./softWrap.tsx";

/** Where the message was sent: the Host, Harness and directory its commands are listed for. */
export interface SentWhere {
  readonly hostKey: string;
  readonly harness: Harness | null;
  readonly cwd: string;
}

export const SentBody = ({ text, where }: { readonly text: string; readonly where: SentWhere }) => {
  const { hostKey, harness, cwd } = where;
  const listed = hasCapability(useHost(hostKey), "harness.commands");
  const wants = listed && harness !== null && mayNameCommand(text);

  // Only a message that may name a command asks, once per Host, Harness and directory.
  useEffect(() => {
    if (wants) ensureCommands(hostKey, harness, cwd);
  }, [wants, hostKey, harness, cwd]);

  return (
    <SentText text={text} commands={useKnownCommands(hostKey, harness, cwd)} wrap={softWrap} />
  );
};
