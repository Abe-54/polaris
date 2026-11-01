import { describe, expect, test } from "bun:test";
import { decideAccess } from "./grants.ts";
import { NotGranted, Pairing, PairingId } from "./index.ts";

const pairing = (grant: Pairing["grant"]) =>
  new Pairing({
    id: PairingId.make("pair_1"),
    name: "Raycast",
    grant,
    createdAt: "2026-10-23T00:00:00Z",
    lastUsedAt: null,
    revokedAt: null,
  });

describe("decideAccess", () => {
  test("a token-less Client is never refused, whatever it asks", () => {
    expect(decideAccess(null, "files.read", null)).toBeNull();
    expect(decideAccess(null, "extensions.revoke", null)).toBeNull();
    expect(decideAccess(null, "dispatch", "SendTurn")).toBeNull();
  });

  test("an Extension passes with the Grant a request needs and is refused without it", () => {
    expect(decideAccess(pairing(["read"]), "subscribeHost", null)).toBeNull();
    expect(decideAccess(pairing(["read"]), "hello", null)).toBeNull();
    expect(decideAccess(pairing(["approve"]), "subscribeHost", null)).toEqual(
      new NotGranted({ what: "subscribeHost", needed: "read" })
    );
    expect(decideAccess(pairing(["read"]), "dispatch", "SendTurn")).toEqual(
      new NotGranted({ what: "dispatch:SendTurn", needed: "turn" })
    );
    expect(decideAccess(pairing(["read", "turn"]), "dispatch", "SendTurn")).toBeNull();
  });

  test("transcribing needs the voice Grant; the voice key stays with Clients", () => {
    expect(decideAccess(pairing(["voice"]), "voice.transcribe", null)).toBeNull();
    expect(decideAccess(pairing(["read", "turn"]), "voice.transcribe", null)).toEqual(
      new NotGranted({ what: "voice.transcribe", needed: "voice" })
    );
    expect(decideAccess(pairing(["voice"]), "voice.setKey", null)).toEqual(
      new NotGranted({ what: "voice.setKey", needed: null })
    );
    expect(decideAccess(pairing(["voice"]), "voice.settings", null)).toEqual(
      new NotGranted({ what: "voice.settings", needed: null })
    );
  });

  test("starting a session that is not supervised also needs approve", () => {
    expect(decideAccess(pairing(["start"]), "dispatch", "StartSession", "supervised")).toBeNull();
    // A planning session asks before every edit, so it approves nothing for itself.
    expect(decideAccess(pairing(["start"]), "dispatch", "StartSession", "plan")).toBeNull();
    expect(decideAccess(pairing(["start"]), "dispatch", "StartSession", "auto")).toEqual(
      new NotGranted({ what: "dispatch:StartSession", needed: "approve" })
    );
    expect(decideAccess(pairing(["start"]), "dispatch", "StartSession")).toEqual(
      new NotGranted({ what: "dispatch:StartSession", needed: "approve" })
    );
    expect(
      decideAccess(pairing(["start", "approve"]), "dispatch", "StartSession", "full-access")
    ).toBeNull();
    expect(decideAccess(pairing(["approve"]), "dispatch", "StartSession", "auto")).toEqual(
      new NotGranted({ what: "dispatch:StartSession", needed: "start" })
    );
    expect(decideAccess(null, "dispatch", "StartSession", "auto")).toBeNull();
  });

  test("what 0.3.0 keeps for Clients is refused to every Extension, naming no Grant", () => {
    const everything = pairing(["read", "approve", "turn", "start", "voice"]);
    expect(decideAccess(everything, "files.read", null)).toEqual(
      new NotGranted({ what: "files.read", needed: null })
    );
    expect(decideAccess(everything, "extensions.list", null)).toEqual(
      new NotGranted({ what: "extensions.list", needed: null })
    );
    // An Extension could otherwise expose the Host to the tailnet on its own.
    expect(decideAccess(everything, "remoteAccess.enable", null)).toEqual(
      new NotGranted({ what: "remoteAccess.enable", needed: null })
    );
    expect(decideAccess(everything, "dispatch", "ArchiveSession")).toEqual(
      new NotGranted({ what: "dispatch:ArchiveSession", needed: null })
    );
  });

  test("an RPC or Command the mapping does not know is refused to Extensions", () => {
    expect(decideAccess(pairing(["read"]), "voice.nope", null)).toEqual(
      new NotGranted({ what: "voice.nope", needed: null })
    );
    expect(decideAccess(pairing(["turn"]), "dispatch", "Nope")).toEqual(
      new NotGranted({ what: "dispatch:Nope", needed: null })
    );
    expect(decideAccess(pairing(["turn"]), "dispatch", null)).toEqual(
      new NotGranted({ what: "dispatch:", needed: null })
    );
  });

  test("a refusal says which Grant is missing in words", () => {
    expect(new NotGranted({ what: "dispatch:SendTurn", needed: "turn" }).message).toBe(
      "dispatch:SendTurn needs the turn Grant"
    );
    expect(new NotGranted({ what: "files.read", needed: null }).message).toBe(
      "files.read is not available to Extensions"
    );
  });
});

test("P9-6: user profiling requires exactly RespondToApproval's approve Grant", () => {
  for (const grant of [[], ["read"], ["turn"], ["approve"], ["read", "approve"]] as const) {
    const caller = pairing([...grant]);
    const attach = decideAccess(caller, "profiles.attach", null);
    const approval = decideAccess(caller, "dispatch", "RespondToApproval");
    expect(attach === null).toBe(approval === null);

    if (approval !== null) expect(attach?.needed).toBe("approve");
  }

  expect(decideAccess(null, "profiles.attach", null)).toBeNull();
});
