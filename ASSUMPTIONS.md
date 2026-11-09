# Assumptions

Decisions made where the spec or a request left room.

- **Feed "All"** shows every item except dismissed ones, including low-relevance items that used to be folded
  away. Sort by Most relevant to bring the best matches up.
- **An item counts as viewed** when its row is selected or its link is opened. Selecting a row is not a taste
  signal; opening the link still is.
- **Popular** means trending now on Hugging Face, and at least 500 stars with a push in the last 30 days on GitHub.
- **Conference sources** combine published proceedings (OpenAlex) with arXiv papers whose comment says they
  were accepted, because proceedings appear months after the papers.
- **X tracking** needs an X API bearer token or a self-hosted RSS bridge (`rss_url`). Public Nitter instances
  are gone.
- **Composer skills** run one at a time and apply to the next message only.
- **Deep research in Ideate** plants a seed first, because the loop runs on seeds, and asks for the seed type.
- **Email and notes-folder sources** can no longer be added in the UI, but existing ones keep working.
