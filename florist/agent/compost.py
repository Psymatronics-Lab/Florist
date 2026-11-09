"""Compost: the persistent pile of everything interesting the user can't commit to yet.

* processing  — every item becomes a row (summary, takeaways, tags, technologies, related seeds, why)
* clusters    — TF-IDF k-means groups, labelled by the model (skill florist-clusters)
* mining      — the model proposes candidate seeds connecting ≥2 items (skill florist-mining)
* promotion   — "start a seed from these" by hand, or accept a mined candidate
"""

from __future__ import annotations

import json
import math
from collections import Counter
from typing import Any

from .. import gateway, profile, research, skills, text
from ..schemas import (
    ClusterLabels,
    CompostItem,
    CompostProcessed,
    FeedItem,
    MiningOutput,
    Seed,
    SeedState,
    now_iso,
)
from ..store import db
from . import greenhouse, loop, preferences


def from_feed(item: FeedItem, note: str = "") -> CompostItem:
    c = CompostItem(
        id=db.new_id("cmp"), title=item.title, links=[item.url] if item.url else [],
        source=item.source_name or item.source_kind, date=item.published or now_iso()[:10],
        summary=item.summary, tags=item.tags, technologies=item.technologies,
        related_seed_ids=item.related_seed_ids, why_interesting=item.why, notes=note, origin="feed",
        feed_item_id=item.id,
    )
    db.put_compost(c)
    try:
        process(c.id, extra=item.content)
    except gateway.LLMError:
        pass
    return db.get_compost(c.id) or c


def add(title: str = "", link: str = "", note: str = "", tags: list[str] | None = None,
        process_now: bool = True) -> CompostItem:
    """Add a link, note or file reference by hand."""
    extra = ""
    if link and not title:
        try:
            meta = research.fetch_page_meta(link)
            title, extra = meta["title"], f"{meta['description']}\n{meta['text'][:2500]}"
        except Exception:
            title = link
    c = CompostItem(id=db.new_id("cmp"), title=title or note[:80] or "Untitled", links=[link] if link else [],
                    source="manual", date=now_iso()[:10], notes=note, tags=tags or [], origin="manual")
    db.put_compost(c)
    preferences.record("compost", "compost", c.id, preferences.features_of(c))
    if process_now:
        try:
            process(c.id, extra=extra)
        except gateway.LLMError as e:
            db.log_activity("compost", f"Could not process “{c.title}”: {e}")
    db.log_activity("compost", f"Composted “{c.title}”")
    return db.get_compost(c.id) or c


def process(item_id: str, extra: str = "") -> CompostItem:
    c = db.get_compost(item_id)
    if not c:
        raise KeyError(item_id)
    vocab = Counter(t for x in db.list_compost() for t in x.tags).most_common(40)
    context = {
        "item": {"title": c.title, "links": c.links, "source": c.source, "notes": c.notes,
                 "summary_so_far": c.summary, "text": extra[:3000]},
        "existing_tags": [t for t, _ in vocab], "profile": profile.brief(),
        "seeds": [{"id": s.id, "title": s.title} for s in db.list_seeds()[:20]],
    }
    out = gateway.complete(gateway.Call(step="compost", hints={"topic": c.title[:40]}),
                           skills.system_prompt("compost"), loop.render_context(context), CompostProcessed)
    seeds = {s.id for s in db.list_seeds()}
    c.summary = out.summary
    c.takeaways = out.takeaways
    c.tags = list(dict.fromkeys([t.lower() for t in c.tags + out.tags]))[:10]
    c.technologies = list(dict.fromkeys([t.lower() for t in c.technologies + out.technologies]))[:10]
    c.why_interesting = c.why_interesting or out.why_interesting
    c.related_seed_ids = list(dict.fromkeys(c.related_seed_ids + [s for s in out.related_seed_ids if s in seeds]))
    c.processed = True
    return db.put_compost(c)


def update(item_id: str, patch: dict[str, Any]) -> CompostItem:
    c = db.get_compost(item_id)
    if not c:
        raise KeyError(item_id)
    data = c.model_dump()
    data.update({k: v for k, v in patch.items() if k not in ("id", "created")})
    return db.put_compost(CompostItem.model_validate(data))


# ---------------------------------------------------------------------------
# Clusters
# ---------------------------------------------------------------------------


def clusters(label: bool = True) -> list[dict[str, Any]]:
    items = db.list_compost()
    if not items:
        return []
    docs = [f"{c.title} {c.summary} {' '.join(c.tags)} {' '.join(c.technologies)}" for c in items]
    vecs = text.tfidf(docs)
    k = max(1, min(8, round(math.sqrt(len(items) / 2)) or 1))
    assign = text.kmeans(vecs, k)
    groups: dict[int, list[int]] = {}
    for i, a in enumerate(assign):
        groups.setdefault(a, []).append(i)
    out = []
    for gid, idx in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        terms = text.top_terms([vecs[i] for i in idx], 5)
        out.append({"id": f"c{gid}", "label": ", ".join(terms[:3]), "terms": terms,
                    "items": [items[i].id for i in idx], "titles": [items[i].title for i in idx][:8]})
    if label and len(out) > 1:
        try:
            labels = gateway.complete(
                gateway.Call(step="clusters", hints={"topic": "themes"}), skills.system_prompt("clusters"),
                loop.render_context({"clusters": [{k: c[k] for k in ("id", "terms", "titles")} for c in out]}),
                ClusterLabels,
            ).labels
            for c in out:
                if labels.get(c["id"]):
                    c["label"] = labels[c["id"]]
        except gateway.LLMError:
            pass
    by_item = {iid: c["label"] for c in out for iid in c["items"]}
    for it in items:
        if it.cluster != by_item.get(it.id, ""):
            it.cluster = by_item.get(it.id, "")
            db.put_compost(it)
    db.kv_set("compost_clusters", json.dumps(out))
    return out


def cached_clusters() -> list[dict[str, Any]]:
    return json.loads(db.kv_get("compost_clusters", "[]"))


# ---------------------------------------------------------------------------
# Mining
# ---------------------------------------------------------------------------


def mining_task(focus: str = "") -> dict[str, Any]:
    groups = cached_clusters() or clusters(label=False)
    items = {c.id: c for c in db.list_compost()}
    return {
        "profile": profile.brief(),
        "focus": focus,
        "clusters": [{"label": g["label"], "items": [
            {"id": i, "date": items[i].date, "title": items[i].title, "summary": items[i].summary[:240],
             "tags": items[i].tags} for i in g["items"] if i in items][:15]} for g in groups],
        "existing_seeds": [{"title": s.title, "prompt": s.prompt[:160]} for s in db.list_seeds(include_candidates=True)
                           if s.state != SeedState.composted][:30],
    }


def apply_mining(out: MiningOutput) -> list[Seed]:
    valid = {c.id for c in db.list_compost()}
    existing = {s.title.lower() for s in db.list_seeds(include_candidates=True)}
    created = []
    for cand in out.candidates:
        ids = [i for i in cand.compost_ids if i in valid]
        if len(ids) < 2 or cand.title.lower() in existing:
            continue
        seed, _ = greenhouse.create_seed(
            f"{cand.prompt}\n\nConnection: {cand.connection}", tier=cand.tier.value, title=cand.title,
            technologies=cand.technologies, compost_ids=ids, origin="mining", state="candidate",
        )
        created.append(seed)
    db.kv_set("last_mining", now_iso())
    db.log_activity("mining", f"Compost mining proposed {len(created)} candidate seed(s)")
    return created


def mine(focus: str = "", model: str | None = None) -> list[Seed]:
    items = db.list_compost()
    if len(items) < 3:
        return []
    out = gateway.complete(
        gateway.Call(step="mining", model=model, hints={"topic": "your compost", "compost": [c.id for c in items[:4]]}),
        skills.system_prompt("mining"), loop.render_context(mining_task(focus)), MiningOutput,
    )
    return apply_mining(out)


def accept_candidate(seed_ref: str) -> Seed:
    seed = greenhouse.set_state(seed_ref, "dormant")
    preferences.record("accept_candidate", "seed", seed.id, preferences.features_of(seed))
    return seed


def reject_candidate(seed_ref: str) -> None:
    seed = db.get_seed(seed_ref)
    if seed:
        preferences.record("reject_candidate", "seed", seed.id, preferences.features_of(seed))
        db.delete_seed(seed.id)


def seed_from(item_ids: list[str], prompt: str = "", tier: str = "exploration", title: str = "") -> Seed:
    items = [c for c in (db.get_compost(i) for i in item_ids) if c]
    if not items:
        raise KeyError("no compost items")
    prompt = prompt or "Combine: " + "; ".join(f"{c.title} — {c.summary[:120]}" for c in items)
    techs = list(dict.fromkeys(t for c in items for t in c.technologies))[:8]
    seed, _ = greenhouse.create_seed(prompt, tier=tier, title=title or (items[0].title[:50] if len(items) == 1 else ""),
                                     technologies=techs, compost_ids=[c.id for c in items], origin="compost")
    for c in items:
        c.related_seed_ids = list(dict.fromkeys(c.related_seed_ids + [seed.id]))
        db.put_compost(c)
        preferences.record("promote", "compost", c.id, preferences.features_of(c))
    return seed
