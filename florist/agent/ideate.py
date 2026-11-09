"""Ideate: the default landing chat — free brainstorming not yet bound to a seed.

Ideate chats keep their messages in the ``chat`` table (``seed_id`` = chat id, ``ic_…``) and a
context list of dragged-in items. A chat can be converted into a seed (skill florist-seed-from-chat),
carrying its compost / feed context along.
"""

from __future__ import annotations

import json
import random
from typing import Any

from .. import gateway, profile, skills
from ..schemas import IdeateReply, SeedFromChat, now_iso
from ..store import db
from . import composer, context, greenhouse, loop, preferences


def _row(chat_id: str) -> dict[str, Any]:
    r = db.q1("SELECT * FROM ideate_chats WHERE id=?", (chat_id,))
    if not r:
        raise KeyError(f"no ideate chat {chat_id}")
    d = dict(r)
    d["context"] = json.loads(d["context"])
    return d


def list_chats(limit: int = 50) -> list[dict[str, Any]]:
    rows = db.q("SELECT * FROM ideate_chats ORDER BY updated DESC LIMIT ?", (limit,))
    return [{**dict(r), "context": json.loads(r["context"])} for r in rows]


def create(title: str = "", ctx: list[dict[str, str]] | None = None) -> dict[str, Any]:
    cid = db.new_id("ic")
    db.ex("INSERT INTO ideate_chats(id, title, seed_id, context, created, updated) VALUES (?,?,?,?,?,?)",
          (cid, title or "New idea", "", json.dumps([context.label(c) for c in (ctx or [])]), now_iso(), now_iso()))
    return get(cid)


def get(chat_id: str) -> dict[str, Any]:
    d = _row(chat_id)
    d["messages"] = greenhouse.chat_history(chat_id, 200)
    return d


def delete(chat_id: str) -> None:
    db.ex("DELETE FROM chat WHERE seed_id=?", (chat_id,))
    db.ex("DELETE FROM ideate_chats WHERE id=?", (chat_id,))


def rename(chat_id: str, title: str) -> dict[str, Any]:
    db.ex("UPDATE ideate_chats SET title=?, updated=? WHERE id=?", (title[:80], now_iso(), chat_id))
    return get(chat_id)


def add_context(chat_id: str, item: dict[str, str]) -> dict[str, Any]:
    d = _row(chat_id)
    if not any(c["kind"] == item["kind"] and c["id"] == item["id"] for c in d["context"]):
        d["context"].append(context.label(item))
        db.ex("UPDATE ideate_chats SET context=?, updated=? WHERE id=?", (json.dumps(d["context"]), now_iso(), chat_id))
    return get(chat_id)


def remove_context(chat_id: str, kind: str, ref: str) -> dict[str, Any]:
    d = _row(chat_id)
    d["context"] = [c for c in d["context"] if not (c["kind"] == kind and c["id"] == ref)]
    db.ex("UPDATE ideate_chats SET context=?, updated=? WHERE id=?", (json.dumps(d["context"]), now_iso(), chat_id))
    return get(chat_id)


def _say(chat_id: str, role: str, content: str, actions: list[dict[str, Any]]) -> None:
    db.ex("INSERT INTO chat(seed_id, role, content, actions, created) VALUES (?,?,?,?,?)",
          (chat_id, role, content, json.dumps(actions), now_iso()))


def _retitle(chat_id: str, current: str, candidate: str) -> str:
    """A new chat takes its title from its first exchange."""
    title = current
    if current in ("New idea", "") and len(greenhouse.chat_history(chat_id, 4)) <= 2:
        title = candidate[:60]
    db.ex("UPDATE ideate_chats SET title=?, updated=? WHERE id=?", (title, now_iso(), chat_id))
    return title


def message(chat_id: str, text: str, skills_on: list[str] | None = None, model: str | None = None,
            effort: str | None = None, tier: str = "") -> dict[str, Any]:
    """One chat turn. A composer skill replaces the normal reply with what that skill produces."""
    d = _row(chat_id)
    skill = composer.pick(skills_on)
    _say(chat_id, "user", text or composer.label(skill), [{"type": "skills", "skills": [skill]}] if skill else [])
    if skill == composer.LOOP_SKILL:
        seed = to_seed(chat_id, tier, model)["seed"]
        reply = f"Planted “{seed['title']}” and started the research loop."
        _say(chat_id, "assistant", reply, [])
        return {"reply": reply, "seed_id": seed["id"], "title": _retitle(chat_id, d["title"], seed["title"])}
    if skill:
        out = composer.run(skill, composer.Scope(
            message=text, title=d["title"], context_items=context.resolve(d["context"]), model=model, effort=effort,
            conversation=[{"role": m["role"], "content": m["content"]} for m in greenhouse.chat_history(chat_id, 20)
                          if m["role"] in ("user", "assistant")]))
        _say(chat_id, "assistant", out["reply"], out["actions"])
        return {**out, "title": _retitle(chat_id, d["title"], text or composer.label(skill))}
    ctx = {
        "profile": profile.brief(),
        "context_items": context.resolve(d["context"]),
        "conversation": [{"role": m["role"], "content": m["content"]} for m in greenhouse.chat_history(chat_id, 20)
                         if m["role"] in ("user", "assistant")],
        "existing_seeds": [s.title for s in db.list_seeds()][:20],
    }
    reply = gateway.complete(
        gateway.Call(step="ideate", model=model, effort=effort, hints={"topic": text[:40]}),
        skills.system_prompt("ideate"), loop.render_context(ctx) + f"\n\nUser: {text}", IdeateReply,
    )
    _say(chat_id, "assistant", reply.reply, [{"type": "suggest_seed", "title": reply.seed_title}] if reply.suggest_seed else [])
    title = _retitle(chat_id, d["title"], reply.seed_title or text)
    return {"reply": reply.reply, "suggest_seed": reply.suggest_seed, "seed_title": reply.seed_title, "title": title}


def to_seed(chat_id: str, tier: str = "", model: str | None = None) -> dict[str, Any]:
    """Distill the conversation into a seed; context items come along as compost / feed links."""
    d = _row(chat_id)
    msgs = greenhouse.chat_history(chat_id, 60)
    ctx = {"profile": profile.brief(), "context_items": context.resolve(d["context"]),
           "conversation": [{"role": m["role"], "content": m["content"]} for m in msgs if m["role"] in ("user", "assistant")]}
    out = gateway.complete(
        gateway.Call(step="seed_from_chat", model=model, hints={"topic": d["title"][:40]}),
        skills.system_prompt("seed_from_chat"), loop.render_context(ctx), SeedFromChat,
    )
    seed, _ = greenhouse.create_seed(
        out.prompt, tier=tier or out.tier.value, title=out.title, technologies=out.technologies,
        constraints={"must_use": out.must_use, "must_avoid": out.must_avoid},
        compost_ids=[c["id"] for c in d["context"] if c["kind"] == "compost"],
        feed_ids=[c["id"] for c in d["context"] if c["kind"] == "feed"], origin="ideate",
        attachment_ids=[c["id"] for c in d["context"] if c["kind"] == "file"],
    )
    db.ex("UPDATE ideate_chats SET seed_id=?, updated=? WHERE id=?", (seed.id, now_iso(), chat_id))
    preferences.record("seed_from", "ideate", chat_id, {"tags": [], "technologies": out.technologies, "title": out.title})
    db.log_activity("seed", f"Ideate chat became seed “{seed.title}”", seed.id)
    return {"seed": seed.model_dump(mode="json")}


def feeling_lucky() -> dict[str, Any]:
    """Pick a well-ranked feed item at random and open an ideate chat about it."""
    items = db.list_feed(["kept"], 40)
    if not items:
        raise ValueError("the feed is empty — fetch some sources first")
    weights = [max(0.05, i.score) ** 2 for i in items]
    item = random.choices(items, weights=weights, k=1)[0]
    chat = create(item.title[:60], [{"kind": "feed", "id": item.id}])
    preferences.record("open", "feed", item.id, preferences.features_of(item))
    return {"chat": chat, "item": item.model_dump(mode="json"),
            "prompt": "What could I build or study with this, given my skills and time?"}
