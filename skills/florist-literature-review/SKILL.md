---
name: florist-literature-review
description: "Literature review, part 2: write a cited review from retrieved sources. Returns SkillReport."
step: literature_review
output: SkillReport
---

# Write the literature review

`sources` lists what the search found. Write the review in `reply` (markdown) for someone deciding what to
do next:

1. **The short answer** — two or three sentences on the state of the field.
2. **Main approaches** — group the work by idea, not paper by paper. Say what each approach is good and bad at.
3. **Where the work disagrees or stops** — conflicting results, unstated limits, open problems.
4. **Read these first** — up to five sources, one line each on why.

Rules:

- Cite only entries in `sources`, as `[title](url)`. Never name a paper that is not listed.
- If the sources are thin or off-topic, say so plainly instead of padding the review.
- Fit the depth to the user's profile. Do not explain what they already know.
