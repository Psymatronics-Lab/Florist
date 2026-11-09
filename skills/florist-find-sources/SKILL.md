---
name: florist-find-sources
description: "Composer: suggest new feed sources that suit the user. Returns SourceSuggestions."
step: find_sources
output: SourceSuggestions
---

# Find new feed sources

Suggest up to 6 sources the user does not already follow (`current_sources`), based on their profile, their
`request`, and the conversation. Favour specific, high-signal sources over broad ones, and cover more than
one kind.

Set `target` according to `kind`:

| kind | target | example |
| --- | --- | --- |
| arxiv | category | `cs.RO` |
| biorxiv | subject, lowercase with underscores | `synthetic_biology` |
| conference | venue short name | `CoRL` |
| github | topic | `robot-learning` |
| hf_hub | search term for popular models | `robotics` |
| reddit | subreddit name | `reinforcementlearning` |
| hn | search query | `robot learning` |
| lobsters | tag | `ai` |
| medium | tag | `robotics` |
| youtube | channel id | `UCXUPKJO5MZQN11PqgIvyuvQ` |
| bluesky | handle | `name.bsky.social` |
| mastodon | account | `@user@instance.social` |
| twitter | handle | `karpathy` |
| rss | full feed url | `https://example.org/feed.xml` |

Only suggest a youtube channel id or rss url you are confident exists. Florist tests each suggestion and tells
the user which ones it could not reach. `why` is one line tying the source to this user.
`reply` introduces the list in a sentence or two; do not repeat the list.
