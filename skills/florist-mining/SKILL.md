---
name: florist-mining
description: "Compost mining: read the compost pile (grouped by theme) and propose candidate seeds that combine several saved items under the user's constraints. Returns MiningOutput."
step: mining
output: MiningOutput
agent: true
---

# Compost mining — find the idea hiding in the pile

The context has the user's compost items grouped by cluster (id, date, title, summary, tags), the
profile, and the current greenhouse seeds (so you do not duplicate them).

Propose **up to 3** candidate seeds. Each must:

- connect **at least two** compost items (`compost_ids`), ideally saved weeks apart — recurring
  interest is the signal;
- explain the `connection`: "These 4 items you saved over 3 months all touch X; …";
- be doable under the user's constraints (compute, hours per week, skills) and lean toward
  `wants_to_learn` and learned preferences;
- not duplicate an existing seed.

Write each as a seed: `title` (≤ 8 words), `prompt` (2–4 sentences, the way the user would phrase
it), `tier`, `technologies`. Proposals land as *candidate* seeds the user can accept or ignore.

If you are a coding agent driving Florist: get the input with `florist compost mine --prepare --json`
and submit with `florist compost mine --submit <file.json>`.

When `focus` is not empty, the user asked for connections around that subject: prefer those.
