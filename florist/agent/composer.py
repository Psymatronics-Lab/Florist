"""Composer skills: the actions behind the chat's plus button.

A skill replaces the normal chat reply for one message and returns what it produced as
``{"reply": markdown, "actions": [...]}``. ``deep_research`` is handled by the callers, because
running the loop means planting a seed (Ideate) or starting a round (seed chat).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable

from .. import gateway, profile, research, skills, text
from ..ingest import sources as fetchers
from ..schemas import (
    FeedIdeas,
    FeedItem,
    FeedSource,
    GroundPlan,
    Model,
    NoveltyReport,
    PolishReport,
    Seed,
    SkillReport,
    SourceSuggestions,
    SuggestedSource,
)
from ..store import db
from . import compost, context, greenhouse, loop

LOOP_SKILL = "deep_research"
MAX_QUERIES = 6
FEED_SAMPLE = 25


@dataclass
class Scope:
    """Where a skill is running: the message plus the chat or seed around it."""

    message: str
    conversation: list[dict[str, Any]] = field(default_factory=list)
    context_items: list[dict[str, Any]] = field(default_factory=list)
    title: str = ""
    seed: Seed | None = None
    model: str | None = None
    effort: str | None = None

    @property
    def topic(self) -> str:
        """What the skill is about. An empty message means 'the idea we have been discussing'."""
        if self.message:
            return self.message
        if self.seed:
            return f"{self.seed.title}. {self.seed.prompt}"
        labels = {s["label"] for s in context.COMPOSER_SKILLS.values()}
        said = [m["content"] for m in self.conversation if m["role"] == "user" and m["content"] not in labels]
        return " ".join(said[-3:]) or self.title


def pick(requested: list[str] | None) -> str:
    """The composer sends one skill at a time; unknown ids are ignored."""
    return next((s for s in requested or [] if s in context.COMPOSER_SKILLS), "")


def label(skill: str) -> str:
    return context.COMPOSER_SKILLS[skill]["label"] if skill else ""


def run(skill: str, scope: Scope) -> dict[str, Any]:
    return RUNNERS[skill](scope)


def _context(s: Scope, **extra: Any) -> dict[str, Any]:
    ctx: dict[str, Any] = {"profile": profile.brief(), "request": s.message, "topic": s.topic,
                           "context_items": s.context_items, "conversation": s.conversation[-12:], **extra}
    if s.seed:
        flower = db.latest_flower(s.seed.id)
        ctx["seed"] = loop._seed_brief(s.seed)
        ctx["flower"] = flower.model_dump(exclude={"visuals", "schema_version"}) if flower else None
    return ctx


def _ask(step: str, schema: type[Model], s: Scope, ctx: dict[str, Any], hints: dict[str, Any] | None = None,
         follow_user_model: bool = True) -> Any:
    call = gateway.Call(step=step, seed_id=s.seed.id if s.seed else "", model=s.model if follow_user_model else None,
                        effort=s.effort if follow_user_model else None, hints={"topic": s.topic[:40], **(hints or {})})
    return gateway.complete(call, skills.system_prompt(step), loop.render_context(ctx), schema)


def _brief(hits: list[research.Hit], abstract: int = 500) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out = []
    for h in hits:
        if h.url in seen:
            continue
        seen.add(h.url)
        out.append({"title": h.title, "url": h.url, "year": h.year, "venue": h.venue, "kind": h.kind,
                    "abstract": h.abstract[:abstract]})
    return out


def _literature(s: Scope) -> dict[str, Any]:
    plan: GroundPlan = _ask("literature_plan", GroundPlan, s, _context(s), follow_user_model=False)
    hits: list[research.Hit] = []
    for q in plan.queries[:MAX_QUERIES]:
        hits += research.search(q.query, kind=q.kind, limit=8)
    found = _brief(hits)
    if not found:
        return {"reply": "I couldn't find anything: the literature search returned no results. Try different wording, "
                         "or check your connection.", "actions": []}
    out: SkillReport = _ask("literature_review", SkillReport, s, _context(s, sources=found[:40]))
    return {"reply": out.reply, "actions": [{"type": "retrieved", "count": len(found)}]}


def _novelty(s: Scope) -> dict[str, Any]:
    topic = s.topic[:200]
    phrase = " ".join(text.tokens(topic)[:6]) or topic
    recent = (date.today() - timedelta(days=540)).isoformat()
    hits = (research.search(topic, kind="paper", limit=8) + research.search(phrase, kind="paper", limit=6, since=recent)
            + research.search(phrase, kind="repo", limit=5))
    out: NoveltyReport = _ask("novelty", NoveltyReport, s, _context(
        s, closest_candidates=_brief(hits, 350), crowdedness_counts=research.crowdedness(phrase)))
    return {"reply": f"**Novelty {out.novelty:.2f} · Crowdedness {out.crowdedness:.2f}**\n\n{out.reply}", "actions": []}


# What ``SuggestedSource.target`` means for each kind.
_TARGET_KEY = {"arxiv": "category", "conference": "venue", "github": "topic", "hf_hub": "query", "reddit": "subreddit",
               "hn": "query", "lobsters": "tag", "medium": "name", "youtube": "channel_id", "bluesky": "handle",
               "mastodon": "account", "twitter": "handle", "rss": "url", "biorxiv": "subject"}


def _source_config(s: SuggestedSource) -> dict[str, Any]:
    cfg: dict[str, Any] = {_TARGET_KEY[s.kind]: s.target.strip()}
    if s.kind == "github":
        cfg["mode"] = "popular"
    elif s.kind == "hf_hub":
        cfg.update(repo_type="models", mode="popular")
    elif s.kind == "medium":
        cfg["mode"] = "tag"
    elif s.kind == "biorxiv":
        cfg["server"] = "biorxiv"
    return cfg


def _reachable(kind: str, cfg: dict[str, Any]) -> bool:
    """Models invent feeds; a suggestion is only marked good after actually fetching it."""
    try:
        return bool(fetchers.FETCHERS[kind](FeedSource(id="probe", kind=kind, name="probe", config=dict(cfg))))  # type: ignore[arg-type]
    except Exception:
        return False


def _find_sources(s: Scope) -> dict[str, Any]:
    have = db.list_sources()
    out: SourceSuggestions = _ask("find_sources", SourceSuggestions, s, _context(
        s, current_sources=[{"kind": x.kind, "name": x.name, "config": x.config} for x in have]))
    known = {(x.kind, tuple(sorted(x.config.items()))) for x in have}
    fresh = [(x, _source_config(x)) for x in out.sources]
    fresh = [(x, c) for x, c in fresh if (x.kind, tuple(sorted(c.items()))) not in known]
    with ThreadPoolExecutor(max_workers=6) as pool:
        ok = list(pool.map(lambda pair: _reachable(pair[0].kind, pair[1]), fresh))
    cards = [{"kind": x.kind, "name": x.name, "config": c, "why": x.why, "ok": good} for (x, c), good in zip(fresh, ok)]
    cards.sort(key=lambda c: not c["ok"])
    return {"reply": out.reply if cards else "I couldn't find any new sources beyond the ones you already follow.",
            "actions": [{"type": "suggest_sources", "sources": cards}] if cards else []}


def _idea_list(ideas: list[Seed], why: dict[str, str]) -> str:
    lines = [f"- **{i.title}** — {why.get(i.id, i.prompt[:160])}" for i in ideas]
    noun = "idea" if len(ideas) == 1 else "ideas"
    return f"{len(ideas)} new {noun}, waiting for you in the [Greenhouse](#/greenhouse):\n\n" + "\n".join(lines)


def _compost_ideas(s: Scope) -> dict[str, Any]:
    if len(db.list_compost()) < 3:
        return {"reply": "Compost needs at least three items before there is anything to connect.", "actions": []}
    ideas = compost.mine(s.message, s.model)
    if not ideas:
        return {"reply": "I didn't find a strong new connection in your compost this time.", "actions": []}
    # create_seed stores "<prompt>\n\nConnection: <why>"; the reply shows only the why
    why = {i.id: i.prompt.partition("Connection: ")[2] for i in ideas}
    return {"reply": _idea_list(ideas, why), "actions": []}


def _feed_sample(s: Scope) -> list[FeedItem]:
    """The part of the feed to read: closest to what was asked, otherwise the newest."""
    items = db.list_feed(["new", "kept"], 300, sort="recent")
    if s.message:
        items = sorted(items, key=lambda f: -text.similarity(s.message, f"{f.title} {f.summary} {' '.join(f.tags)}"))
    return items[:FEED_SAMPLE]


def _feed_ideas(s: Scope) -> dict[str, Any]:
    items = _feed_sample(s)
    if not items:
        return {"reply": "Your feed is empty. Pull some sources first.", "actions": []}
    existing = {x.title.lower() for x in db.list_seeds(include_candidates=True)}
    out: FeedIdeas = _ask("feed_ideas", FeedIdeas, s, _context(
        s, feed_items=[{"id": i.id, "title": i.title, "source": i.source_name or i.source_kind, "published": i.published,
                        "summary": (i.summary or i.content)[:300], "tags": i.tags} for i in items],
        existing_seeds=sorted(existing)[:30]), {"feed": [i.id for i in items[:3]]})
    valid = {i.id for i in items}
    ideas, why = [], {}
    for c in out.candidates:
        ids = [i for i in c.feed_ids if i in valid]
        if not ids or c.title.lower() in existing:
            continue
        seed, _ = greenhouse.create_seed(f"{c.prompt}\n\nConnection: {c.connection}", tier=c.tier.value, title=c.title,
                                         technologies=c.technologies, feed_ids=ids, origin="feed", state="candidate")
        ideas.append(seed)
        why[seed.id] = c.connection
    if not ideas:
        return {"reply": f"I read {len(items)} feed items and nothing stood out as a new idea.", "actions": []}
    db.log_activity("mining", f"Feed reading proposed {len(ideas)} candidate seed(s)")
    return {"reply": f"I read {len(items)} feed items. " + _idea_list(ideas, why), "actions": []}


def _polish(s: Scope) -> dict[str, Any]:
    found = _brief(research.search(s.topic[:200], kind="paper", limit=5), 300)
    out: PolishReport = _ask("polish", PolishReport, s, _context(s, related_work=found))
    return {"reply": f"**Stage: {out.stage.capitalize()}.** {out.why}\n\n{out.reply}", "actions": []}


RUNNERS: dict[str, Callable[[Scope], dict[str, Any]]] = {
    "literature": _literature, "novelty": _novelty, "find_sources": _find_sources,
    "compost_ideas": _compost_ideas, "feed_ideas": _feed_ideas, "polish": _polish,
}
