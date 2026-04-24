# Ledger schema

One finding per file at `ledger/findings/F-NNNN-slug.md`. YAML frontmatter + markdown body with fixed H2 headings.

## Frontmatter (required fields)

```yaml
---
id: F-0042
summary: Glare rotates at slope ≈ −1 against pod-roll in active-roll windows
status: agreed                   # open | disputed | agreed | revisited | superseded
sources:
  - scripts/145_pod_roll_vs_glare.js
  - data/145_pod_roll_vs_glare.csv
  - logs/36_pod_roll_coupling.md
  - X-US9121758
depends_on: [F-0018, F-0023]
updated: 2026-04-19
---
```

**Optional fields:**

```yaml
supersedes: F-0041               # if this finding replaces another
superseded_by: F-0047            # if an updated version of this exists
reproducibility: scripted        # scripted | recipe | one-shot
parent: F-0040                   # for sub-findings (child of F-0040)
```

## Field definitions

| Field | Type | Notes |
|---|---|---|
| `id` | `F-NNNN` | Monotonic, forward-only. Sub-findings use dotted notation (`F-0042.1`). |
| `summary` | one sentence | Written by the least-persuaded agent. No adjectives that reveal a stance. |
| `status` | enum | See **Status values** below. |
| `sources` | list | Mix of `paths/relative/to/repo` and `X-<slug>` external IDs (resolved via `ledger/sources/MANIFEST.json`). |
| `depends_on` | list of F-IDs | Parent findings whose resolution affects this one. |
| `updated` | ISO date | Last status or content change. |
| `supersedes` / `superseded_by` | F-ID | Versioning link. Never delete, always supersede. |
| `reproducibility` | enum | See **Reproducibility tiers** below. |

## Status values

| Value | Meaning |
|---|---|
| `open` | Stated but not yet examined. |
| `disputed` | Multiple agents have conflicting stances; resolution blocked. |
| `agreed` | Mutual assent reached. Transition requires human signoff or second-agent steelman signoff. |
| `revisited` | Previously `agreed`, reopened with new evidence or challenge. |
| `superseded` | Replaced by a newer finding — retained for history. |

Auto-transition: adding a `## Views` entry with a conflicting `stance` flips `open → disputed`.

## Resolution types (when `status: agreed`)

In `## Resolution`, tag how closure happened:

- `demonstration` — reproducible pipeline, mutual assent. Strongest.
- `acceptance` — one side accepted without independent verification.
- `no-objection` — nobody objected in N rounds. Flagged as cheaply reopenable.
- `bracketed` — set aside to make progress. Not actually resolved.

## Reproducibility tiers (for findings backed by a data product)

- `scripted` — end-to-end deterministic pipeline. Inputs + scripts + params → byte-identical output. Hash-pinnable.
- `recipe` — documented human-in-the-loop steps. Output expected similar, not bit-identical. Example: GUI-driven Sitrec operations.
- `one-shot` — artifact exists, steps only partially known. Not expected to reproduce.

## Body (fixed H2 headings)

```markdown
## Summary

Prose elaboration — numbers, windows, correlations. What a skeptical reader needs to verify the claim without opening linked files.

## Views

- **mick** (`interpretive`): stance in one line. Rationale in one short paragraph. Cite source.
  > "quoted text from the source"
  Source: https://metabunk.org/posts/NNN or agents/agent-mick/r6.md

- **cholla** (`interpretive`): ...

- **marik** (`framing`): ...

## Evidence pipeline

Steps from raw data to finding. Each step names the script + parameters + output:

1. `scripts/145_pod_roll_vs_glare.js` consumes `data/145_pod_roll_vs_glare.csv` (NCC samples, corr ≥ 0.9) and HUD pod-roll from `vendor/sitrec-data/GimbalData.csv`.
2. Robust OLS fit → slope, correlation, n.
3. Windows T3/T4/T6 defined by pod-roll-rate > threshold in frames [...].

## Resolution

- **Type:** `demonstration`
- **Date:** 2026-04-19
- **Signoff:** mick (repo owner); cholla signed off in R6 §2; marik conceded in R4 §6.

## What would revise this

Concrete, testable reopening conditions:

1. A repeat of the NCC measurement with a different cloud mask produces a slope outside [−1.3, −0.5].
2. A mechanism other than derotator-downstream-of-coelostat produces slope −1 natively.
3. The ATFLIR public patents are shown not to describe the coelostat architecture we cited.
```

## External source IDs

`ledger/sources/MANIFEST.json`:

```json
{
  "X-US9121758": {
    "type": "patent",
    "title": "Multi-axis pointing system",
    "url": "https://patents.google.com/patent/US9121758",
    "local": "ledger/sources/patents/US9121758.pdf",
    "sha256": "..."
  },
  "X-MB-14839": {
    "type": "metabunk-thread",
    "url": "https://www.metabunk.org/threads/14839/",
    "local": "ledger/sources/metabunk-threads/14839.md",
    "sha256": "..."
  },
  "X-marik2026-transcript": {
    "type": "transcript",
    "title": "Marik von Rennenkampff Gimbal video transcript 2026",
    "local": "ledger/sources/transcripts/marik2026.txt",
    "sha256": "..."
  }
}
```

## What does NOT go in the ledger

- Implementation bugs → use git issues or `logs/`.
- In-progress agent discussions → stay in `agents/agent-*/rN.md`.
- Ephemeral TODOs → use the task list.

The ledger is for durable investigation state. If it wouldn't matter in six months, it doesn't belong.
