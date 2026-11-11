/**
 * User access (ADR 0110, which supersedes ADR 0100's enrolment): the user gate is off.
 * Every token-less Client holds user access, so a second Desktop App on a Host is never refused.
 * Extensions and Linked Devices keep their own gates. Multi-device enrolment is ENG-927.
 */
import { UserAccessGate } from "@polaris/protocol";

/** The user gate the protocol's `DaemonRpcs` asks for: it lets every request through. */
export const openUserAccessGate = UserAccessGate.of((effect) => effect);
