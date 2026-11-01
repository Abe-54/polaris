# Rule index

Every rule, where its text lives, and how it is enforced. "Citation" means
the full text is in the named canonical file; do not restate it.

## From DESIGN.md (citations)

| ID | Source | Enforcement |
| --- | --- | --- |
| rule/colour-means-something | DESIGN.md, Colors, Named Rules | agent |
| rule/constellation-colour | DESIGN.md, Colors, Named Rules; Constellation (DAG) | agent |
| rule/starlight-is-rare | DESIGN.md, Colors, Named Rules | agent |
| rule/no-colour-alone | DESIGN.md, Colors, Named Rules | agent |
| rule/context-is-quiet | DESIGN.md, Components, Turns in the conversation | agent (`contextLabel` tests) |
| rule/signal-text-variants | DESIGN.md, Colors, Named Rules | agent + contrast table |
| rule/faint-is-not-content | DESIGN.md, Colors, Neutral | agent |
| rule/severity-is-a-badge | DESIGN.md, Colors, Named Rules | agent |
| rule/severity-vs-state | DESIGN.md, Colors, Named Rules | agent |
| rule/low-confidence-dims | DESIGN.md, Colors, Named Rules | agent |
| rule/syntax-is-moonlit | DESIGN.md, Colors, Named Rules | agent |
| rule/git-is-a-letter | DESIGN.md, Colors, Named Rules | agent |
| rule/data-source-label | DESIGN.md, Data | agent |
| rule/sentence-case | DESIGN.md, Typography, Named Rules | agent |
| rule/glossary-lowercase | DESIGN.md, Typography, Named Rules | agent |
| rule/tabular-numbers | DESIGN.md, Typography, Named Rules | agent |
| rule/density-through-tokens | DESIGN.md, Layout, Named Rules | agent |
| rule/no-dashboard-clutter | DESIGN.md, Layout, Named Rules | agent |
| rule/commands-are-chips | DESIGN.md, Layout, Named Rules; Skills and Slash Commands in the composer | agent + `composerFlow.ts` smoke |
| rule/only-working-moves | DESIGN.md, Session State indicators | agent |
| rule/needs-you-is-loudest | DESIGN.md, Session State indicators | agent |
| rule/ellipsis-means-input | DESIGN.md, Menus | `apps/desktop/src/renderer/shell/menu/ellipsis.test.ts` |
| rule/scene-text-contrast | DESIGN.md, Pixel scenes | agent |

## From PRODUCT.md (citations)

| ID | Source | Enforcement |
| --- | --- | --- |
| rule/no-ai-purple | PRODUCT.md, Anti-references; DESIGN.md, Don'ts | agent |
| rule/code-is-the-content | PRODUCT.md, Product Principles 5 | agent |
| rule/point-at-risk | PRODUCT.md, Product Principles 3 | agent |

## Skill-defined rules (full text in the named reference)

| ID | Reference | Enforcement |
| --- | --- | --- |
| rule/glossary-exact | copy.md | agent |
| rule/glossary-not-proper-nouns | copy.md (cites DESIGN.md, rule/glossary-lowercase) | agent |
| rule/say-what-happened | copy.md | agent |
| rule/copy-no-rationale | copy.md | agent |
| rule/destructive-names-object | copy.md | agent |
| rule/design-reachable-states | resilience.md | agent |
| rule/remote-is-normal | resilience.md | agent |
| rule/long-content-survives | resilience.md | agent |

Lint enforcement is deferred until apps/desktop exists; candidates are
rule/sentence-case, the no-emoji/no-exclamation mechanics, and hard-coded
colours outside the token set.
