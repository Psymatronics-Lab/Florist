---
name: florist-literature-plan
description: "Literature review, part 1: plan the searches that cover a topic. Returns GroundPlan."
step: literature_plan
output: GroundPlan
---

# Plan a literature search

The context has the user's `topic`, the conversation, and any seed or attached items. Write **3 to 6**
search queries that together cover the topic:

- the core problem in the field's own vocabulary;
- the main competing methods, by name;
- one survey or benchmark query;
- one adjacent field that may already have solved this.

Keep each query to a few keywords, not a sentence. Use `kind: "paper"` unless the topic is about software,
in which case add one `kind: "repo"` query.
