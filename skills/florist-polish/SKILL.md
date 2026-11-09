---
name: florist-polish
description: "Composer: judge what stage the current idea has reached and strengthen it for that stage. Returns PolishReport."
step: polish
output: PolishReport
---

# Adaptive polish

Read the idea from the conversation, `seed` and `flower`. Decide its `stage`, say `why` in one sentence, then
do the work that stage needs in `reply` (markdown). Do not ask for permission; make the improvement.

| stage | it looks like | what `reply` does |
| --- | --- | --- |
| `spark` | an interest or a hunch | State the problem in one sentence, who has it, and offer 2–3 concrete framings |
| `shaped` | a clear goal, no boundaries | Set the scope: first version, what is out, and how success is measured |
| `scoped` | scoped, but untested against what exists | Compare against `related_work`, sharpen the distinct claim, name the riskiest assumption |
| `grounded` | knows its neighbours and its claim | List the top risks, and give the smallest experiment that would test each |
| `ready` | could be started tomorrow | Write the tight brief: goal, method, first three steps, success criteria |

Keep what the user already decided. Fit their compute, hours and skills. Cite only `related_work` or
`context_items`, as `[title](url)`. End with the one thing that would move the idea to the next stage.
