---
name: florist-novelty
description: "Composer novelty check: compare one idea against its closest existing work. Returns NoveltyReport."
step: novelty
output: NoveltyReport
---

# Check novelty

The idea is in `topic`, the conversation, or `seed`. Florist already searched for `closest_candidates` and
counted matching work in `crowdedness_counts`. Judge only from these.

`novelty` (0–1), grounded in the candidates:

| Score | Meaning |
| --- | --- |
| 0.0–0.2 | Already done; an existing paper or repo does this nearly as stated |
| 0.3–0.5 | Done in a nearby setting; the twist is small but real |
| 0.6–0.8 | Clear gap, with a named closest work that does not cover it |
| 0.9–1.0 | Nothing close found and the search was thorough; rare, and must be justified |

`crowdedness` (0–1) comes from the counts: many recent works means crowded.

`gap`: what is genuinely not done. If you cannot name one, novelty is at most 0.3.

`reply` (markdown): the two or three closest works as `[title](url)` and exactly how the idea differs from
each, then what to do about it: reuse, narrow the claim, or proceed. Cite only `closest_candidates`.
