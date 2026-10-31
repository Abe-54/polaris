import { describe, expect, test } from "bun:test";
import { ProfileDetail, ProfilesSnapshot } from "@polaris/protocol";
import { Schema } from "effect";
import { FIXTURE_SESSION } from "./fixtures.ts";
import { FIXTURE_PROFILES, fixtureProfilesApi } from "./profiles.ts";

const at = { hostKey: "local", sessionId: FIXTURE_SESSION };

const snapshots = (api: ReturnType<typeof fixtureProfilesApi>) => {
  const seen: Array<ProfilesSnapshot> = [];

  api.watch(at, { next: (s) => seen.push(s) });

  return seen;
};

describe("Profiles fixtures", () => {
  test("every snapshot and readable recording decodes against the protocol", async () => {
    const api = fixtureProfilesApi({ large: true });
    const [first] = snapshots(api);

    expect(Schema.is(ProfilesSnapshot)(first)).toBe(true);

    for (const profile of first?.profiles ?? []) {
      const answer = await api.get(at, profile.id);

      if (profile.status === "failed") expect(answer.ok).toBe(false);
      else if (answer.ok) {
        expect(Schema.is(ProfileDetail)(answer.value)).toBe(true);
        // Parents precede children, as the protocol promises.
        expect(answer.value.nodes.every((n, i) => n.parent === null || n.parent < i)).toBe(true);
      } else throw new Error(answer.error.message);
    }
  });

  test("restarting a process Polaris didn't start is refused; an owned one starts recording", async () => {
    const api = fixtureProfilesApi({ owned: [4242] });
    const seen = snapshots(api);
    const refused = await api.restart(at, 1);

    expect(refused.ok ? null : refused.error.code).toBe("E-PROFILE-PROCESS-NOT-OWNED");
    expect(seen).toHaveLength(1);

    const started = await api.restart(at, 4242);

    expect(started.ok && started.value.status).toBe("recording");
    expect(seen.at(-1)?.profiles.length).toBe(FIXTURE_PROFILES.length + 1);
  });
});
