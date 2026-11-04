---
status: accepted
---

# A phone can forget a Host that never answers Unlink

## Context

Unlink on the phone (RX1-3) forgets a Host only after that Host revokes the phone's key, so a
Host never goes on trusting a key the phone has dropped without the user knowing. A Host that
can't be reached at its saved relay and address (its relay URL changed, or it's gone) never
answers, so it stays in the phone's list. Linking it again is refused by `checkLinkedHosts`
(ADR 0083: a link may not give a known Host a new key, address or relay), and the user's only
way out was clearing the app's storage.

## Decision

**When a Host doesn't answer Unlink, the Hosts screen offers to forget it on this phone
anyway, after a confirmation that says it still trusts the phone until it is unlinked on the
Mac in Settings → Devices.**

- Forgetting drops the Host's connection and its entry in the Keychain, as a revoked Unlink
  does (`leaving` in `apps/mobile/src/relay/unlink.ts`); forgetting the last Host also forgets
  the keys, so the next link starts as a new device.
- `checkLinkedHosts` is unchanged. A link still never replaces the key, address or relay of a
  Host this phone keeps; only a Host the user chose to forget can be linked again.
- The phone sends the forgotten Host nothing: it isn't answering. Its push and Live Activity
  registrations stay on that Host until the Mac unlinks the phone.

## Consequences

- Between forgetting and unlinking on the Mac, the Host accepts the phone's key while the phone
  no longer follows it. The copy says so, and the Mac's Devices page lists the phone.
- A forged link naming a Host the user has just forgotten is accepted like any first link: the
  same exposure as linking a new phone (ADR 0083).
