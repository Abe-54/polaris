---
name: product-design
description: >-
  Single entry point for product design and user-facing work in Polaris (the
  Desktop App in apps/desktop, Paper mockups, brand and pixel assets). Use
  whenever work changes what a user sees, understands, chooses, or does:
  shaping flows; designing or building views and components (Orchestrator,
  Review, Editor, Constellation, toasts, onboarding); making or changing
  Paper mockups; reviewing screens, screenshots, or diffs; copy, hierarchy,
  layout, density, motion, accessibility, and loading, empty, error,
  Connection State, or destructive states. Trigger on design, UX, UI, mockup,
  Paper, artboard, brand, polish, audit, review, improve, or copy requests.
  Also use when Daemon or protocol behavior changes a user-visible outcome.
  Not for backend-only work with no UI consequence.
---

# Polaris Product Design

Make the interface right for a developer supervising several agents for
hours: calm by default, signals only when they mean something, attention
pointed at risk. Working pixels are not enough: choose the right
interaction, cover every reachable state, keep the domain words exact, and
verify the result in both themes and all three densities.

## Canonical sources

- `PRODUCT.md`: users, purpose, voice, brand commitments, principles,
  accessibility. Read for any material change.
- `DESIGN.md`: tokens (frontmatter), named rules (`rule/...`), components,
  motion, performance, brand. The design system's single source of truth.
- `CONTEXT.md`: the glossary. Every domain word in UI copy comes from here
  (Agent Session, Turn, Needs You, Constellation, Task, Attempt...).
- Paper file "Polaris — Orchestrator"
  (https://app.paper.design/file/01M3JV1J857QNW61TGHZYR6GMZ): the accepted
  mockups. Pages: Orchestrator, Review, Editor, Brand, Brand deck.
- This skill adds only what those lack. Never restate them; cite them
  (e.g. "DESIGN.md, rule/starlight-is-rare").

## Request modes

Resolve the mode from the verb and artifact before acting. When ambiguous,
use the narrowest mode the verb supports. A screenshot, artboard, or file
identifies scope; it does not authorize edits.

| Mode | Typical request | Required behavior |
| --- | --- | --- |
| Shape | "How should X work?", "Design the flow" | Brief, compare alternatives (ask with previews when the choice is the user's), define states and open decisions. No mockups or code unless asked. |
| Mock | "Mock up", "add an artboard", "show me" | Build in Paper following `references/paper.md`, reusing existing artboards; screenshot, fix, finish. Record new decisions in DESIGN.md. |
| Implement | "Build", "fix", "make it match" | Resolve material decisions, then the smallest coherent change. Match the exemplar and DESIGN.md tokens. |
| Review | "Critique", "audit", "what's wrong?" | Inspect rendered evidence; prioritized findings citing rule IDs. No edits unless asked. |
| Copy | "Fix the copy" | Edit user-facing language only; report structural blockers. |
| Harden | "Polish", "production-ready", "edge cases" | Keep the settled direction; fix states, resilience, density, themes, accessibility. |

A material decision changes the user's task, default, scope, consequence,
navigation, interaction surface, domain vocabulary, or reachable states.
Token swaps and copy mechanics usually are not.

## Decision authority

1. The user's explicit goal and constraints.
2. Verified product behavior and system truth (protocol, Daemon, Harness).
3. `PRODUCT.md`, `DESIGN.md`, `CONTEXT.md`, and this skill's references.
4. Accepted exemplars in `exemplars/`.
5. Adjacent accepted artboards in the same area.
6. General interface heuristics.

A mockup is evidence of a decision only where its exemplar says so; the
rest of an artboard is scaffolding.

## Routing

| Need | Load |
| --- | --- |
| Product, flow, or component decision | `references/product-judgment.md` + PRODUCT.md |
| Visual, tokens, type, elevation, motion | DESIGN.md |
| Copy, labels, glossary words | `references/copy.md` + CONTEXT.md |
| States, long content, remote Hosts, failure | `references/resilience.md` |
| A specific surface | `references/surfaces.md` router, then its exemplar |
| Making or editing Paper mockups | `references/paper.md` |
| Rule IDs, sources, enforcement | `references/rules.md` |
| What has no standard yet | `references/coverage-gaps.md` |
| Turning session evidence into guidance | `references/intake.md` |

The impeccable skill may be used for craft passes (critique, polish,
typeset); this skill remains the entry point and its rules win.

## Polaris operating constraints

- Both themes, every time. Dark is default (night sky); light is equal
  (meadow at dawn). Every colour is a `-dark`/`-light` token pair.
- All three densities (Calm, Balanced, Compact) through tokens only
  (DESIGN.md, rule/density-through-tokens).
- Signals stay rare: colour only for Starlight, Session State, Severity,
  diffs, git status, syntax, or Harness hue; only the Working dither loops.
- Electron budgets: display-rate frames (180 Hz measured), under 1 GB for
  the whole app. Animate `transform` and `opacity`; a morph may also
  animate `border-radius` and `clip-path` (DESIGN.md, Motion and
  Performance).
- Reduce Motion stills the dither; the colourblind diff palette (`-cvd`)
  must stay legible.
- Glossary words exactly, lowercase unless proper nouns
  (DESIGN.md, rule/glossary-lowercase).

## Workflow

1. Name the surface and mode.
2. Read PRODUCT.md and the product logic that decides states, permissions,
   side effects, and which Host or Harness is involved.
3. For Shape, Mock, Implement, Harden, or full Review: write the brief
   (`references/product-judgment.md`).
4. Map reachable states only (`references/resilience.md`).
5. Load the surface exemplar and routed references.
6. Do the work. Findings and non-mechanical changes cite rule IDs.
7. Verify (below), then record any new decision in DESIGN.md and a line in
   `decision-log.md` if guidance changed.

## Verification

- Mockups: screenshot every changed artboard; check spacing, alignment of
  repeated lanes, contrast, clipping; at most one fix round, then stop.
- Code (once apps/desktop exists): `bun run typecheck && bun run test &&
  bun run lint`; inspect both themes, all three densities, Reduce Motion,
  the `-cvd` palette, keyboard order and the Starlight focus ring.
- Long session titles, branch names, 11+ Workspaces, remote Host latency,
  and Reconnecting or Offline Hosts.

## Review output

Findings first, ordered by user impact:

- **P0**: blocks the primary task, hides a Critical finding or a Needs You,
  or severe accessibility failure.
- **P1**: misleading consequence or state, missing critical state, broken
  density or theme.
- **P2**: friction, inconsistency, weak hierarchy, a signal used as
  decoration.
- **P3**: minor craft.

Each finding: location (file:line or artboard and element), verified or
inferred, rule ID or canonical source, user consequence, smallest fix.
