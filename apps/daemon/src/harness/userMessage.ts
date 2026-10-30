/** A steer as its Turn shows it: the user's text and, when it carried any, its attachments. */
import { type Attachment, TurnItem } from "@polaris/protocol";

export const steerItem = (
  id: string,
  text: string,
  attachments: ReadonlyArray<Attachment> = []
): TurnItem =>
  TurnItem.cases.UserMessage.make(
    attachments.length === 0 ? { id, text } : { id, text, attachments: [...attachments] }
  );
