"""Chat context: items dragged or attached into a conversation, and the composer's skill catalog.

Context items are ``{"kind": "compost" | "feed" | "source" | "seed" | "file", "id": ...}``.
What each composer skill does when it runs lives in ``agent/composer.py``.
"""

from __future__ import annotations

from typing import Any

from .. import text
from ..store import db

COMPOSER_SKILLS: dict[str, dict[str, str]] = {
    "deep_research": {"label": "Deep research", "description": "Run the full research loop on this idea"},
    "literature": {"label": "Review literature", "description": "Search the literature and write a cited review"},
    "novelty": {"label": "Check novelty", "description": "Only the novelty check: closest work and the remaining gap"},
    "find_sources": {"label": "Find feed sources", "description": "Suggest new sources for your feed"},
    "compost_ideas": {"label": "Compost ideas", "description": "Find connections in your compost and propose ideas"},
    "feed_ideas": {"label": "Feed ideas", "description": "Read part of your feed and propose ideas"},
    "polish": {"label": "Adaptive polish", "description": "Judge what stage this idea is at and shore it up"},
}


def resolve(items: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Turn context references into compact dicts for prompts (unknown refs are skipped)."""
    out = []
    for it in items:
        kind, ref = it.get("kind"), it.get("id", "")
        if kind == "compost" and (c := db.get_compost(ref)):
            out.append({"kind": "compost", "id": c.id, "title": c.title, "summary": c.summary or c.notes,
                        "takeaways": c.takeaways, "links": c.links, "tags": c.tags})
        elif kind == "feed" and (f := db.get_feed_item(ref)):
            out.append({"kind": "feed", "id": f.id, "title": f.title, "summary": f.summary or f.content[:500],
                        "url": f.url, "source": f.source_name or f.source_kind})
        elif kind == "source" and (n := db.get_node(ref)):
            out.append({"kind": "source", "id": n.id, "title": n.title, "summary": n.summary or
                        (n.data.get("abstract") or "")[:600], "url": n.url})
        elif kind == "seed" and (s := db.get_seed(ref)):
            out.append({"kind": "seed", "id": s.id, "title": s.title, "summary": s.prompt})
        elif kind == "file" and (a := db.get_attachment(ref)):
            out.append({"kind": "file", "id": a.id, "title": a.name, "text": a.text[:12000]})
    return out


def label(item: dict[str, str]) -> dict[str, str]:
    r = resolve([item])
    return {**item, "title": r[0]["title"] if r else item.get("id", "")}


def search_compost(query: str, limit: int = 12) -> list[dict[str, Any]]:
    items = db.list_compost()
    if not query.strip():
        return [{"id": c.id, "title": c.title, "tags": c.tags[:3]} for c in items[:limit]]
    scored = [(text.similarity(query, f"{c.title} {c.summary} {' '.join(c.tags)} {c.notes}"), c) for c in items]
    scored = [x for x in scored if x[0] > 0 or query.lower() in x[1].title.lower()]
    scored.sort(key=lambda x: -x[0])
    return [{"id": c.id, "title": c.title, "tags": c.tags[:3], "score": round(s, 3)} for s, c in scored[:limit]]
