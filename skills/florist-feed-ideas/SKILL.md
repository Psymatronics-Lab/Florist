---
name: florist-feed-ideas
description: "Composer: read part of the feed and propose ideas. Returns FeedIdeas."
step: feed_ideas
output: FeedIdeas
---

# Find ideas in the feed

`feed_items` is a slice of the user's feed. Propose **up to 3** ideas that could become seeds. Each must:

- come from specific items (`feed_ids`), ideally two or more that say something new together;
- explain the `connection`: what these items suggest and why it suits this user;
- be doable under the user's compute, hours and skills, and lean toward what they want to learn;
- not repeat anything in `existing_seeds`.

Write each as a seed: `title` (at most 8 words), `prompt` (2–4 sentences, the way the user would phrase it),
`tier`, `technologies`. If `request` narrows the search, follow it. If nothing is worth proposing, return no
candidates. They land as proposals the user can plant or ignore.
