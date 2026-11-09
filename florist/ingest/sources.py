"""Feed source fetchers. Each returns raw ``FeedItem``s (status ``new``) for one ``FeedSource``.

| kind     | config                                         |
|----------|------------------------------------------------|
| rss      | url (any RSS/Atom: blogs, labs, friends)       |
| youtube  | channel_id (channel RSS; transcripts optional) |
| arxiv    | category (e.g. cs.LG) or query                 |
| alphaxiv | interval ("7 Days"), sort ("Hot")              |
| github   | mode new/popular + topic, or releases + repo   |
| hf_hub   | repo_type, mode popular/new, query             |
| twitter  | handle or query; X API token or rss_url bridge |
| medium   | mode tag/author/publication, name              |
| biorxiv  | server biorxiv/medrxiv, subject                |
| conference | venue (proceedings + accepted preprints)     |
| hn       | query (Hacker News stories)                    |
| email    | folder (IMAP) or path (local .eml/.mbox dir)   |
"""

from __future__ import annotations

import email
import email.policy
import imaplib
import mailbox
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable

import feedparser
import httpx

from .. import config
from ..research import UA, TIMEOUT
from ..schemas import FeedItem, FeedSource
from ..store import db


def _item(src: FeedSource, **kw) -> FeedItem:
    return FeedItem(id=db.new_id("fd"), source_id=src.id, source_kind=src.kind, source_name=src.name, **kw)


def _strip_html(s: str) -> str:
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s or "", flags=re.S | re.I)
    return " ".join(re.sub(r"<[^>]+>", " ", s).split())


def _fetch(url: str, **params) -> httpx.Response:
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = c.get(url, params=params or None)
    r.raise_for_status()
    return r


def _parse_feed(src: FeedSource, url: str, limit: int = 30) -> list[FeedItem]:
    parsed = feedparser.parse(_fetch(url).content)
    items = []
    for e in parsed.entries[:limit]:
        content = e.get("summary", "") or ""
        if e.get("content"):
            content = e["content"][0].get("value", content)
        published = ""
        for key in ("published_parsed", "updated_parsed"):
            if e.get(key):
                published = datetime(*e[key][:6], tzinfo=timezone.utc).date().isoformat()
                break
        items.append(_item(src, external_id=e.get("id", e.get("link", "")), url=e.get("link", ""),
                           title=_strip_html(e.get("title", "(untitled)"))[:300], author=e.get("author", ""),
                           published=published, content=_strip_html(content)[:3000]))
    return items


def fetch_rss(src: FeedSource) -> list[FeedItem]:
    return _parse_feed(src, src.config["url"])


def fetch_youtube(src: FeedSource) -> list[FeedItem]:
    cid = src.config.get("channel_id", "")
    url = src.config.get("url") or f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
    items = _parse_feed(src, url, limit=15)
    for it in items:
        m = re.search(r"v=([\w-]{11})", it.url)
        if m:
            it.content = (it.content + "\n" + _transcript(m.group(1)))[:4000]
    return items


def _transcript(video_id: str) -> str:
    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # optional extra
    except ImportError:
        return ""
    try:
        api = YouTubeTranscriptApi()
        parts = api.fetch(video_id)
        return " ".join(getattr(p, "text", "") for p in parts)[:3000]
    except Exception:
        return ""


def fetch_arxiv(src: FeedSource) -> list[FeedItem]:
    if src.config.get("category"):
        return _parse_feed(src, f"https://rss.arxiv.org/rss/{src.config['category']}", limit=40)
    from ..research import arxiv

    since = (datetime.now(timezone.utc) - timedelta(days=14)).date().isoformat()
    return [_item(src, external_id=h.external_id, url=h.url, title=h.title, published=h.published,
                  author=", ".join(h.authors[:3]), content=h.abstract)
            for h in arxiv(src.config.get("query", "machine learning"), limit=25, since=since)]


def fetch_alphaxiv(src: FeedSource) -> list[FeedItem]:
    r = _fetch("https://api.alphaxiv.org/papers/v3/feed", pageNum=0, pageSize=src.config.get("size", 25),
               sort=src.config.get("sort", "Hot"), interval=src.config.get("interval", "7 Days"))
    items = []
    for p in r.json().get("papers", []):
        pid = p.get("universal_paper_id") or p.get("canonical_id") or p.get("id")
        summary = (p.get("paper_summary") or {}).get("summary") or p.get("feed_description") or ""
        items.append(_item(src, external_id=pid, url=f"https://www.alphaxiv.org/abs/{pid}",
                           title=p.get("title", ""), author=", ".join((p.get("authors") or [])[:3]),
                           published=(p.get("publication_date") or "")[:10],
                           content=f"{summary}\n\n{p.get('abstract', '')}"[:3000], tags=(p.get("topics") or [])[:5]))
    return items


def fetch_github(src: FeedSource) -> list[FeedItem]:
    mode = src.config.get("mode") or ("releases" if src.config.get("repo") else "new")
    if mode == "releases":
        return _parse_feed(src, f"https://github.com/{src.config['repo']}/releases.atom", limit=10)
    from ..research import github

    topic = src.config.get("topic", "machine-learning")
    if mode == "popular":  # established projects that are still active
        since = (datetime.now(timezone.utc) - timedelta(days=int(src.config.get("days", 30)))).date().isoformat()
        hits = github(f"topic:{topic} stars:>={int(src.config.get('min_stars', 500))}", limit=20, since=since)
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=int(src.config.get("days", 7)))).date().isoformat()
        hits = github(f"topic:{topic} created:>={since}", limit=15)
    return [_item(src, external_id=h.external_id, url=h.url, title=h.title, published=h.published,
                  content=f"{h.abstract} (★{h.stars}, {h.venue})") for h in hits]


def fetch_hn(src: FeedSource) -> list[FeedItem]:
    from ..research import hackernews

    since = (datetime.now(timezone.utc) - timedelta(days=int(src.config.get("days", 3)))).date().isoformat()
    return [_item(src, external_id=h.external_id, url=h.url, title=h.title, published=h.published, content=h.abstract)
            for h in hackernews(src.config.get("query", "LLM"), limit=15, since=since)]


# ---------------------------------------------------------------------------
# Email newsletters: IMAP folder or a local mail folder; each email is split into items
# ---------------------------------------------------------------------------


class _LinkBlocks(HTMLParser):
    """Collect (anchor text, href, surrounding text) blocks from newsletter HTML."""

    def __init__(self) -> None:
        super().__init__()
        self.blocks: list[dict[str, str]] = []
        self._href: str | None = None
        self._anchor: list[str] = []
        self._text: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("style", "script"):
            self._skip += 1
        if tag == "a":
            self._href = dict(attrs).get("href") or ""
            self._anchor = []
        if tag in ("p", "li", "h1", "h2", "h3", "h4", "tr", "div") and self._text:
            self._text.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("style", "script"):
            self._skip = max(0, self._skip - 1)
        if tag == "a" and self._href is not None:
            anchor = " ".join("".join(self._anchor).split())
            context = " ".join("".join(self._text[-40:]).split())[-500:]
            self.blocks.append({"href": self._href, "anchor": anchor, "context": context})
            self._href = None

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        self._text.append(data)
        if self._href is not None:
            self._anchor.append(data)


_SKIP_LINK = re.compile(r"unsubscribe|manage|preferences|privacy|mailto:|twitter\.com/intent|facebook|linkedin\.com/share|"
                        r"view in browser|list-manage|/account|substack\.com/app|utm_medium=email.*footer", re.I)


def split_newsletter(src: FeedSource, msg: email.message.Message) -> list[FeedItem]:
    subject = str(msg.get("subject", "(newsletter)"))
    sender = str(msg.get("from", ""))
    date = ""
    try:
        date = email.utils.parsedate_to_datetime(msg.get("date")).date().isoformat()  # type: ignore[arg-type]
    except Exception:
        pass
    html_part, text_part = "", ""
    for part in msg.walk():
        ctype = part.get_content_type()
        try:
            payload = part.get_content()  # type: ignore[attr-defined]
        except Exception:
            continue
        if ctype == "text/html" and not html_part:
            html_part = payload
        elif ctype == "text/plain" and not text_part:
            text_part = payload
    items: list[FeedItem] = []
    if html_part:
        p = _LinkBlocks()
        p.feed(html_part)
        seen = set()
        for b in p.blocks:
            href, anchor = b["href"], b["anchor"]
            if not href.startswith("http") or _SKIP_LINK.search(href + " " + anchor) or len(anchor) < 12:
                continue
            key = href.split("?")[0]
            if key in seen:
                continue
            seen.add(key)
            items.append(_item(src, external_id=key, url=href, title=anchor[:200], author=sender, published=date,
                               content=f"From newsletter “{subject}”. {b['context']}"))
    if not items:
        body = text_part or _strip_html(html_part)
        items.append(_item(src, external_id=str(msg.get("message-id", subject)), title=subject, author=sender,
                           published=date, content=body[:3000]))
    return items[:25]


def fetch_email(src: FeedSource) -> list[FeedItem]:
    s = config.get().email
    local = src.config.get("path") or s.local_dir
    messages: list[email.message.Message] = []
    if local:
        root = Path(local).expanduser()
        for f in sorted(root.glob("*.eml"))[-30:]:
            messages.append(email.message_from_bytes(f.read_bytes(), policy=email.policy.default))
        for f in root.glob("*.mbox"):
            messages.extend(list(mailbox.mbox(str(f)))[-30:])
    else:
        password = config.key_for("imap")
        if not (s.imap_host and s.username and password):
            raise RuntimeError("email source needs settings.email.imap_host/username and keys.imap (password)")
        folder = src.config.get("folder") or s.folder
        with imaplib.IMAP4_SSL(s.imap_host, s.imap_port) as m:
            m.login(s.username, password)
            m.select(folder, readonly=True)
            since = (datetime.now() - timedelta(days=int(src.config.get("days", 7)))).strftime("%d-%b-%Y")
            _, data = m.search(None, "SINCE", since)
            for num in (data[0].split() if data and data[0] else [])[-30:]:
                _, msg_data = m.fetch(num, "(BODY.PEEK[])")
                raw = msg_data[0][1] if msg_data and isinstance(msg_data[0], tuple) else b""
                messages.append(email.message_from_bytes(raw, policy=email.policy.default))
    items: list[FeedItem] = []
    for msg in messages:
        items.extend(split_newsletter(src, msg))
    return items


def fetch_hf_papers(src: FeedSource) -> list[FeedItem]:
    """Hugging Face daily papers (community-curated arXiv picks)."""
    data = _fetch("https://huggingface.co/api/daily_papers", limit=src.config.get("limit", 30)).json()
    items = []
    for d in data:
        p = d.get("paper") or {}
        pid = p.get("id", "")
        items.append(_item(src, external_id=pid, url=f"https://huggingface.co/papers/{pid}", title=p.get("title", ""),
                           author=", ".join(a.get("name", "") for a in (p.get("authors") or [])[:3]),
                           published=(p.get("publishedAt") or "")[:10],
                           content=((p.get("ai_summary") or "") + "\n\n" + (p.get("summary") or ""))[:3000],
                           tags=[k.lower() for k in (p.get("ai_keywords") or [])[:5]]))
    return items


def fetch_hf_hub(src: FeedSource) -> list[FeedItem]:
    """Popular (trending) or newly created models, datasets or Spaces on the Hugging Face Hub."""
    repo_type = src.config.get("repo_type", "models")
    if repo_type not in ("models", "datasets", "spaces"):
        raise ValueError(f"unknown Hugging Face repo type {repo_type!r}")
    popular = src.config.get("mode", "popular") == "popular"
    params: dict[str, Any] = {"sort": "trendingScore" if popular else "createdAt", "direction": -1,
                              "limit": src.config.get("limit", 25)}
    if src.config.get("query"):
        params["search"] = src.config["query"]
    today = datetime.now(timezone.utc).date().isoformat()
    prefix = {"models": "", "datasets": "datasets/", "spaces": "spaces/"}[repo_type]
    items = []
    for r in _fetch(f"https://huggingface.co/api/{repo_type}", **params).json():
        rid = r.get("id", "")
        stats = [f"{r['likes']} likes" if r.get("likes") is not None else "",
                 f"{r['downloads']} downloads" if r.get("downloads") is not None else "",
                 r.get("pipeline_tag") or r.get("sdk") or ""]
        tags = [t for t in (r.get("tags") or []) if ":" not in t][:5]
        # a trending entry is news today, however old the repo is
        items.append(_item(src, external_id=f"{repo_type}/{rid}", url=f"https://huggingface.co/{prefix}{rid}", title=rid,
                           author=rid.split("/")[0], published=today if popular else (r.get("createdAt") or "")[:10],
                           content=f"Hugging Face {repo_type[:-1]}. " + " · ".join(s for s in stats if s), tags=tags))
    return items


def fetch_hackster(src: FeedSource) -> list[FeedItem]:
    return _parse_feed(src, "https://www.hackster.io/news.atom", limit=30)


def fetch_medium(src: FeedSource) -> list[FeedItem]:
    name = str(src.config.get("name", "")).strip().lstrip("@")
    if not name:
        raise ValueError("Medium source needs a tag, author or publication name")
    path = {"tag": f"tag/{name}", "author": f"@{name}", "publication": name}[src.config.get("mode", "tag")]
    return _parse_feed(src, f"https://medium.com/feed/{path}", limit=20)


def fetch_biorxiv(src: FeedSource) -> list[FeedItem]:
    server = src.config.get("server", "biorxiv")
    if server not in ("biorxiv", "medrxiv"):
        raise ValueError(f"unknown preprint server {server!r}")
    subject = src.config.get("subject") or "all"
    return _parse_feed(src, f"https://connect.{server}.org/{server}_xml.php?subject={subject}", limit=40)


def fetch_twitter(src: FeedSource) -> list[FeedItem]:
    """X has no free feed: use the official API with a bearer token, or an RSS bridge the user runs."""
    if src.config.get("rss_url"):
        return _untitled_posts(_parse_feed(src, src.config["rss_url"], limit=25), "Post on X")
    token = config.key_for("twitter")
    if not token:
        raise RuntimeError("X tracking needs an X API bearer token (X_BEARER_TOKEN or keys.twitter) or an RSS bridge url")
    handle = str(src.config.get("handle", "")).lstrip("@")
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": UA, "Authorization": f"Bearer {token}"}) as c:
        fields = {"max_results": 25, "tweet.fields": "created_at"}
        if handle:
            user = c.get(f"https://api.x.com/2/users/by/username/{handle}")
            user.raise_for_status()
            r = c.get(f"https://api.x.com/2/users/{user.json()['data']['id']}/tweets",
                      params={**fields, "exclude": "retweets,replies"})
        else:
            r = c.get("https://api.x.com/2/tweets/search/recent", params={**fields, "query": src.config["query"]})
        r.raise_for_status()
    return [_item(src, external_id=t["id"], url=f"https://x.com/{handle or 'i'}/status/{t['id']}",
                  title=" ".join(t.get("text", "").split())[:120] or "Post on X", author=handle,
                  published=(t.get("created_at") or "")[:10], content=t.get("text", ""))
            for t in r.json().get("data") or []]


VENUES = {
    "NeurIPS": "Neural Information Processing Systems", "ICML": "International Conference on Machine Learning",
    "ICLR": "International Conference on Learning Representations", "CVPR": "Computer Vision and Pattern Recognition",
    "ICCV": "International Conference on Computer Vision", "ECCV": "European Conference on Computer Vision",
    "ACL": "Annual Meeting of the Association for Computational Linguistics",
    "EMNLP": "Empirical Methods in Natural Language Processing", "AAAI": "AAAI Conference on Artificial Intelligence",
    "ICRA": "International Conference on Robotics and Automation",
    "IROS": "International Conference on Intelligent Robots and Systems", "RSS": "Robotics: Science and Systems",
    "CoRL": "Conference on Robot Learning", "HRI": "International Conference on Human-Robot Interaction",
    "SIGGRAPH": "SIGGRAPH", "KDD": "Knowledge Discovery and Data Mining",
}
_NOT_ACCEPTED = re.compile(r"submitted|under review|in submission", re.I)


def _accepted_preprints(src: FeedSource, venue: str) -> list[FeedItem]:
    """arXiv papers whose comment says they appear at this venue — proceedings lag these by months."""
    year = datetime.now(timezone.utc).year
    query = " OR ".join(f'co:"{venue} {y}"' for y in (year, year + 1))
    parsed = feedparser.parse(_fetch("https://export.arxiv.org/api/query", search_query=query, sortBy="submittedDate",
                                     sortOrder="descending", max_results=40).content)
    items = []
    for e in parsed.entries:
        comment = e.get("arxiv_comment", "") or ""
        if _NOT_ACCEPTED.search(comment):
            continue
        when = e.get("published_parsed")
        items.append(_item(src, external_id=e.get("id", ""), url=e.get("link", ""), title=_strip_html(e.get("title", ""))[:300],
                           author=e.get("author", ""), published=datetime(*when[:6], tzinfo=timezone.utc).date().isoformat() if when else "",
                           content=f"{comment}\n\n{_strip_html(e.get('summary', ''))}"[:3000], tags=[venue.lower()]))
    return items


def _proceedings(src: FeedSource, venue: str) -> list[FeedItem]:
    from ..research import _unindex

    key = config.key_for("openalex")
    auth = {"api_key": key} if key else {}
    source_id = src.config.get("openalex_id")
    if not source_id:  # resolved once, then saved with the source
        found = _fetch("https://api.openalex.org/sources", search=VENUES.get(venue, venue), filter="type:conference",
                       per_page=1, select="id", **auth).json().get("results") or []
        if not found:
            return []
        source_id = src.config["openalex_id"] = found[0]["id"].rsplit("/", 1)[-1]
    since = (datetime.now(timezone.utc) - timedelta(days=int(src.config.get("days", 365)))).date().isoformat()
    works = _fetch("https://api.openalex.org/works", filter=f"primary_location.source.id:{source_id},from_publication_date:{since}",
                   sort="publication_date:desc", per_page=30,
                   select="id,doi,title,publication_date,authorships,abstract_inverted_index", **auth).json()
    return [_item(src, external_id=w.get("id", ""), url=w.get("doi") or w.get("id", ""), title=(w.get("title") or "").strip()[:300],
                  author=", ".join(a["author"]["display_name"] for a in (w.get("authorships") or [])[:3] if a.get("author")),
                  published=w.get("publication_date") or "", content=_unindex(w.get("abstract_inverted_index"))[:3000],
                  tags=[venue.lower()]) for w in works.get("results", []) if w.get("title")]


def fetch_conference(src: FeedSource) -> list[FeedItem]:
    venue = str(src.config.get("venue", "")).strip()
    if not venue:
        raise ValueError("conference source needs a venue")
    items, errors = [], []
    for fetcher in (_accepted_preprints, _proceedings):
        try:
            items += fetcher(src, venue)
        except Exception as e:  # one half answering is still useful
            errors.append(str(e))
    if errors and not items:
        raise RuntimeError("; ".join(errors))
    return items


def fetch_reddit(src: FeedSource) -> list[FeedItem]:
    sub = str(src.config.get("subreddit", "MachineLearning")).removeprefix("r/")
    return _parse_feed(src, f"https://www.reddit.com/r/{sub}/top/.rss?t=week", limit=25)


def fetch_lobsters(src: FeedSource) -> list[FeedItem]:
    return _parse_feed(src, f"https://lobste.rs/t/{src.config.get('tag', 'ai')}.rss", limit=25)


def _untitled_posts(items: list[FeedItem], label: str) -> list[FeedItem]:
    for it in items:  # social posts have no titles; use the text
        if not it.title or it.title == "(untitled)" or it.title == it.url:
            it.title = it.content[:120] or label
    return items


def fetch_bluesky(src: FeedSource) -> list[FeedItem]:
    handle = str(src.config["handle"]).lstrip("@")
    return _untitled_posts(_parse_feed(src, f"https://bsky.app/profile/{handle}/rss", limit=25), "Bluesky post")


def fetch_mastodon(src: FeedSource) -> list[FeedItem]:
    user, _, host = str(src.config["account"]).lstrip("@").partition("@")
    return _untitled_posts(_parse_feed(src, f"https://{host}/@{user}.rss", limit=25), "Mastodon post")


def fetch_folder(src: FeedSource) -> list[FeedItem]:
    """A local folder of notes / clippings / saved pages (.md .txt .html .url) — e.g. a phone share target."""
    root = Path(str(src.config["path"])).expanduser()
    items = []
    for f in sorted(root.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)[:40]:
        if f.suffix.lower() not in (".md", ".txt", ".html", ".htm", ".url"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        url_m = re.search(r"https?://[^\s)>\]]+", text)
        if f.suffix.lower() in (".html", ".htm"):
            text = _strip_html(text)
        title = next((ln.lstrip("# ").strip() for ln in text.splitlines() if ln.strip()), f.stem)[:200]
        items.append(_item(src, external_id=str(f), url=url_m.group(0) if url_m else "", title=title,
                           content=text[:3000],
                           published=datetime.fromtimestamp(f.stat().st_mtime, timezone.utc).date().isoformat()))
    return items


FETCHERS: dict[str, Callable[[FeedSource], list[FeedItem]]] = {
    "rss": fetch_rss, "youtube": fetch_youtube, "arxiv": fetch_arxiv, "alphaxiv": fetch_alphaxiv,
    "hf_papers": fetch_hf_papers, "github": fetch_github, "hn": fetch_hn, "email": fetch_email,
    "reddit": fetch_reddit, "lobsters": fetch_lobsters, "bluesky": fetch_bluesky, "mastodon": fetch_mastodon,
    "folder": fetch_folder, "hf_hub": fetch_hf_hub, "twitter": fetch_twitter, "hackster": fetch_hackster,
    "medium": fetch_medium, "biorxiv": fetch_biorxiv, "conference": fetch_conference,
}

STARTER_SOURCES = [
    FeedSource(id="src_alphaxiv_hot", kind="alphaxiv", name="alphaXiv trending", config={"interval": "7 Days"}),
    FeedSource(id="src_arxiv_cslg", kind="arxiv", name="arXiv cs.LG", config={"category": "cs.LG"}, enabled=False),
    FeedSource(id="src_hf_daily", kind="hf_papers", name="Hugging Face daily papers"),
    FeedSource(id="src_hn_llm", kind="hn", name="Hacker News: LLM", config={"query": "LLM"}),
    FeedSource(id="src_gh_llm", kind="github", name="GitHub: new llm repos", config={"topic": "llm", "days": 7}),
]
# Defaults from the first release: never re-add these to an install that already has sources.
ORIGINAL_STARTERS = {s.id for s in STARTER_SOURCES}


def _off(sid: str, kind: str, label: str, /, **cfg: Any) -> FeedSource:
    return FeedSource(id=sid, kind=kind, name=label, config=cfg, enabled=False)  # type: ignore[arg-type]


STARTER_SOURCES += [  # robotics, machine learning and nearby fields; off until the user switches them on
    _off("src_arxiv_csro", "arxiv", "arXiv cs.RO (robotics)", category="cs.RO"),
    _off("src_arxiv_csai", "arxiv", "arXiv cs.AI", category="cs.AI"),
    _off("src_arxiv_cscv", "arxiv", "arXiv cs.CV (vision)", category="cs.CV"),
    _off("src_arxiv_cscl", "arxiv", "arXiv cs.CL (language)", category="cs.CL"),
    _off("src_arxiv_statml", "arxiv", "arXiv stat.ML", category="stat.ML"),
    _off("src_biorxiv_bioinf", "biorxiv", "bioRxiv: bioinformatics", server="biorxiv", subject="bioinformatics"),
    _off("src_hf_models_hot", "hf_hub", "Hugging Face: popular models", repo_type="models", mode="popular"),
    _off("src_hf_models_new", "hf_hub", "Hugging Face: new models", repo_type="models", mode="new"),
    _off("src_hf_robotics", "hf_hub", "Hugging Face: popular robotics models", repo_type="models", mode="popular", query="robotics"),
    _off("src_gh_robotics_hot", "github", "GitHub: popular robotics repos", mode="popular", topic="robotics"),
    _off("src_gh_robotics_new", "github", "GitHub: new robotics repos", mode="new", topic="robotics"),
    _off("src_gh_ml_hot", "github", "GitHub: popular machine-learning repos", mode="popular", topic="machine-learning"),
    _off("src_reddit_ml", "reddit", "r/MachineLearning", subreddit="MachineLearning"),
    _off("src_reddit_robotics", "reddit", "r/robotics", subreddit="robotics"),
    _off("src_conf_corl", "conference", "CoRL proceedings", venue="CoRL"),
    _off("src_conf_icra", "conference", "ICRA proceedings", venue="ICRA"),
    _off("src_conf_neurips", "conference", "NeurIPS proceedings", venue="NeurIPS"),
    _off("src_hackster", "hackster", "Hackster.io news"),
    _off("src_medium_robotics", "medium", "Medium: robotics", mode="tag", name="robotics"),
    _off("src_ieee_robotics", "rss", "IEEE Spectrum: robotics", url="https://spectrum.ieee.org/feeds/topic/robotics.rss"),
    _off("src_robot_report", "rss", "The Robot Report", url="https://www.therobotreport.com/feed/"),
    _off("src_ros_discourse", "rss", "ROS Discourse", url="https://discourse.ros.org/latest.rss"),
    _off("src_bair_blog", "rss", "Berkeley AI Research blog", url="https://bair.berkeley.edu/blog/feed.xml"),
    _off("src_deepmind_blog", "rss", "Google DeepMind blog", url="https://deepmind.google/blog/rss.xml"),
]
