"""Inspiration feed: fetch → de-duplicate → triage (summary, tags, why) → rank → fold.

Ranking blends four signals::

    score = 0.50 · model relevance       (skill florist-feed-triage)
          + 0.25 · learned preference     (agent/preferences.py)
          + 0.15 · similarity to active seeds (TF-IDF)
          + 0.10 · recency

Items under ``profile.feed_fold_threshold`` are folded away, never deleted.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .. import gateway, profile, research, skills, text
from ..agent import preferences
from ..schemas import FeedItem, FeedSource, FeedStatus, FeedTriage, now_iso
from ..store import db
from . import sources as fetchers

BATCH = 12


def ensure_starter_sources() -> None:
    """Offer each default source once, so a source the user deleted does not come back."""
    existing = {s.id for s in db.list_sources()}
    stored = db.kv_get("starter_sources_offered")
    offered = set(json.loads(stored)) if stored else (set(fetchers.ORIGINAL_STARTERS) if existing else set())
    for s in fetchers.STARTER_SOURCES:
        if s.id not in offered and s.id not in existing:
            db.put_source(s)
    db.kv_set("starter_sources_offered", json.dumps(sorted(offered | {s.id for s in fetchers.STARTER_SOURCES})))


def due(src: FeedSource, now: datetime | None = None) -> bool:
    if not src.enabled:
        return False
    if not src.last_fetched:
        return True
    age = (now or datetime.now(timezone.utc)) - datetime.fromisoformat(src.last_fetched)
    return age.total_seconds() >= src.interval_hours * 3600


def fetch(source_id: str | None = None, force: bool = False, triage_items: bool = True) -> dict[str, Any]:
    """Fetch due sources (or one source), store new items and triage them."""
    report: dict[str, Any] = {"sources": [], "new": 0}
    srcs = [s for s in db.list_sources() if (source_id is None or s.id == source_id)]
    new_ids: list[str] = []
    for src in srcs:
        if not force and not due(src):
            continue
        entry = {"id": src.id, "name": src.name, "new": 0}
        try:
            items = fetchers.FETCHERS[src.kind](src)
            for it in items:
                if db.insert_feed_item(it):
                    new_ids.append(it.id)
                    entry["new"] += 1
            src.last_error = ""
        except Exception as e:
            src.last_error = str(e)[:300]
            entry["error"] = src.last_error
        src.last_fetched = now_iso()
        db.put_source(src)
        report["sources"].append(entry)
    report["new"] = len(new_ids)
    if new_ids:
        db.log_activity("feed", f"Fetched {len(new_ids)} new feed items")
    if triage_items and new_ids:
        report["triaged"] = triage(new_ids)
    return report


def add_link(url: str, note: str = "", triage_now: bool = True) -> FeedItem:
    """'Save to Florist' — paste a link (share sheet / browser extension call this too)."""
    try:
        meta = research.fetch_page_meta(url)
    except Exception:
        meta = {"title": url, "description": "", "text": ""}
    item = FeedItem(id=db.new_id("fd"), source_kind="manual", source_name="saved link", url=url,
                    external_id=url, title=meta["title"][:300] or url,
                    content=(note + "\n" + meta["description"] + "\n" + meta["text"]).strip()[:3500],
                    published=datetime.now(timezone.utc).date().isoformat())
    if not db.insert_feed_item(item):
        existing = db.q1("SELECT doc FROM feed_items WHERE dedupe_key=?", (url,))
        return FeedItem.model_validate_json(existing["doc"]) if existing else item
    if triage_now:
        triage([item.id])
        item = db.get_feed_item(item.id) or item
    return item


def triage(ids: list[str]) -> int:
    """Summarize, tag and score items in batches. Falls back to lexical scoring if the model fails."""
    items = [i for i in (db.get_feed_item(x) for x in ids) if i]
    seeds = db.list_seeds()
    seed_ctx = [{"id": s.id, "title": s.title, "prompt": s.prompt[:200]} for s in seeds[:20]]
    recent_compost = [c.title for c in db.list_compost()[:15]]
    prof_brief = profile.brief()
    done = 0
    for k in range(0, len(items), BATCH):
        batch = items[k:k + BATCH]
        context = {
            "profile": prof_brief, "seeds": seed_ctx, "recently_composted": recent_compost,
            "items": [{"id": i.id, "source": i.source_name or i.source_kind, "title": i.title,
                       "excerpt": i.content[:700], "tags_hint": i.tags} for i in batch],
        }
        triaged: dict[str, Any] = {}
        try:
            out = gateway.complete(
                gateway.Call(step="feed_triage", hints={"refs": [i.id for i in batch], "topic": "your interests"}),
                skills.system_prompt("feed_triage"),
                "## Context\n```json\n" + json.dumps(context, ensure_ascii=False, indent=1) + "\n```",
                FeedTriage,
            )
            triaged = {t.ref: t for t in out.items}
        except gateway.LLMError as e:
            db.log_activity("feed", f"Feed triage fell back to lexical scoring: {e}")
        for item in batch:
            t = triaged.get(item.id)
            if t:
                item.summary, item.why = t.summary, t.why
                item.tags = list(dict.fromkeys(item.tags + [x.lower() for x in t.tags]))[:8]
                item.technologies = [x.lower() for x in t.technologies][:6]
                item.relevance = t.relevance
                item.related_seed_ids = [s for s in t.related_seed_ids if any(x.id == s for x in seeds)]
            else:
                item.summary = item.summary or item.content[:240]
            rank(item, seeds)
            db.put_feed_item(item)
            done += 1
    return done


def rank(item: FeedItem, seeds: list | None = None) -> FeedItem:
    seeds = seeds if seeds is not None else db.list_seeds()
    pref = preferences.score(preferences.features_of(item))
    body = f"{item.title} {item.summary} {' '.join(item.tags)}"
    sim = max((text.similarity(body, f"{s.title} {s.prompt}") for s in seeds), default=0.0)
    recency = 0.5
    if item.published:
        try:
            age = (datetime.now(timezone.utc).date() - datetime.fromisoformat(item.published[:10]).date()).days
            recency = max(0.0, 1 - age / 30)
        except ValueError:
            pass
    relevance = item.relevance if item.why else max(item.relevance, min(1.0, sim * 2))
    item.score = round(min(1.0, 0.5 * relevance + 0.25 * pref + 0.15 * min(1.0, sim * 2.5) + 0.1 * recency), 3)
    if not item.why and sim > 0.15 and seeds:
        best = max(seeds, key=lambda s: text.similarity(body, f"{s.title} {s.prompt}"))
        item.why = f"Shares vocabulary with your seed “{best.title}”."
    if item.status in (FeedStatus.new, FeedStatus.kept, FeedStatus.folded):
        item.status = FeedStatus.kept if item.score >= profile.load().feed_fold_threshold else FeedStatus.folded
    return item


def rerank_all() -> int:
    seeds = db.list_seeds()
    items = db.list_feed(["new", "kept", "folded"], limit=1000)
    for it in items:
        db.put_feed_item(rank(it, seeds))
    return len(items)


# ---------------------------------------------------------------------------
# One-gesture actions
# ---------------------------------------------------------------------------


def act(item_id: str, action: str, seed_id: str = "", note: str = "", tier: str = "exploration") -> dict[str, Any]:
    """compost | attach (to seed_id) | seed (new seed) | dismiss | keep | unfold | open | view"""
    from ..agent import compost, greenhouse

    item = db.get_feed_item(item_id)
    if not item:
        raise KeyError(f"no feed item {item_id}")
    feats = preferences.features_of(item)
    result: dict[str, Any] = {"item": item_id, "action": action}
    if action == "compost":
        c = compost.from_feed(item, note)
        item.status = FeedStatus.composted
        result["compost_id"] = c.id
        preferences.record("compost", "feed", item.id, feats)
    elif action == "attach":
        seed = db.get_seed(seed_id)
        if not seed:
            raise KeyError(f"no seed {seed_id}")
        if item.id not in seed.feed_ids:
            seed.feed_ids.append(item.id)
            db.put_seed(seed)
        item.status = FeedStatus.attached
        item.related_seed_ids = list(dict.fromkeys(item.related_seed_ids + [seed.id]))
        result["seed_id"] = seed.id
        preferences.record("attach", "feed", item.id, feats)
    elif action == "seed":
        prompt = note or f"{item.title}. {item.summary or item.content[:400]}"
        seed, questions = greenhouse.create_seed(prompt, tier=tier or "exploration", title=item.title[:60],
                                                 technologies=item.technologies, feed_ids=[item.id], origin="feed")
        item.status = FeedStatus.seeded
        result.update({"seed_id": seed.id, "questions": questions})
        preferences.record("seed_from", "feed", item.id, feats)
    elif action == "dismiss":
        item.status = FeedStatus.dismissed
        preferences.record("dismiss", "feed", item.id, feats)
    elif action in ("keep", "unfold"):
        item.status = FeedStatus.kept
        preferences.record("unfold" if action == "unfold" else "keep", "feed", item.id, feats)
    elif action == "open":
        item.viewed_at = item.viewed_at or now_iso()
        preferences.record("open", "feed", item.id, feats)
    elif action == "view":  # selecting a row marks it viewed but is too weak to be a taste signal
        item.viewed_at = item.viewed_at or now_iso()
    else:
        raise ValueError(f"unknown feed action {action}")
    db.put_feed_item(item)
    if action != "view":
        db.log_activity("feed", f"{action}: {item.title[:80]}", result.get("seed_id", ""))
    return result
