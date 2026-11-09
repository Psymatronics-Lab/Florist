"""Greenhouse: seeds, their lifecycle, live chat steering and direction actions."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from .. import gateway, profile, skills
from ..schemas import (
    ChatReply,
    CompostItem,
    Constraints,
    FollowUp,
    FollowUpQuestions,
    NodeStatus,
    Seed,
    SeedState,
    Tier,
    now_iso,
)
from ..store import db
from . import loop, preferences


def create_seed(prompt: str, tier: str = "personal", title: str = "", technologies: list[str] | None = None,
                constraints: dict[str, Any] | None = None, priority: int = 3, compost_ids: list[str] | None = None,
                feed_ids: list[str] | None = None, related_papers: list[str] | None = None,
                origin: str = "manual", state: str = "dormant", ask_followups: bool = False,
                passive: bool = False, attachment_ids: list[str] | None = None) -> tuple[Seed, list[str]]:
    """Plant a seed. With ``ask_followups`` Florist asks at most two questions (skill florist-followups)."""
    questions: list[str] = []
    techs = list(technologies or [])
    tier_val = Tier(tier)
    if ask_followups:
        try:
            fu = gateway.complete(
                gateway.Call(step="followups", hints={"topic": (title or prompt)[:40]}),
                skills.system_prompt("followups"),
                loop.render_context({"prompt": prompt, "title": title, "tier": tier, "technologies": techs,
                                     "constraints": constraints or {}, "profile": profile.brief()}),
                FollowUpQuestions,
            )
            questions = fu.questions[:2]
            title = title or fu.title
            techs = list(dict.fromkeys(techs + fu.technologies))
        except gateway.LLMError:
            pass
    title = title or _title_from(prompt)
    seed = Seed(
        id=db.new_id("sd"), slug=db.unique_slug(title), title=title, prompt=prompt, tier=tier_val,
        state=SeedState(state), priority=priority, technologies=techs, related_papers=related_papers or [],
        compost_ids=compost_ids or [], feed_ids=feed_ids or [], attachment_ids=attachment_ids or [],
        constraints=Constraints(**(constraints or {})),
        followups=[FollowUp(question=q) for q in questions], origin=origin, passive=passive,  # type: ignore[arg-type]
    )
    db.put_seed(seed)
    loop.ensure_root(seed)
    db.log_activity("seed", f"Planted seed “{seed.title}” ({seed.tier.value})", seed.id)
    return seed, questions


def _title_from(prompt: str) -> str:
    words = prompt.strip().split()
    t = " ".join(words[:8])
    return (t[:60] + "…") if len(words) > 8 else t or "Untitled seed"


def answer_followups(seed_ref: str, answers: list[str]) -> Seed:
    seed = _seed(seed_ref)
    for f, a in zip(seed.followups, answers):
        f.answer = a
    return db.put_seed(seed)


def update_seed(seed_ref: str, patch: dict[str, Any]) -> Seed:
    seed = _seed(seed_ref)
    data = seed.model_dump(mode="json")
    if "constraints" in patch and isinstance(patch["constraints"], dict):
        data["constraints"].update(patch.pop("constraints"))
    if "budget" in patch and isinstance(patch["budget"], dict):
        data["budget"].update(patch.pop("budget"))
    if "priority" in patch and patch["priority"] != seed.priority:
        data["priority_since"] = now_iso()
    data.update({k: v for k, v in patch.items() if k not in ("id", "created")})
    new = Seed.model_validate(data)
    if new.title != seed.title:
        new.slug = db.unique_slug(new.title, seed.id)
    db.put_seed(new)
    if new.title != seed.title or new.prompt != seed.prompt:
        loop.ensure_root(new)
    return new


def set_state(seed_ref: str, state: str) -> Seed:
    seed = _seed(seed_ref)
    seed.state = SeedState(state)
    db.put_seed(seed)
    db.log_activity("seed", f"“{seed.title}” → {state}", seed.id)
    return seed


def _seed(ref: str) -> Seed:
    seed = db.get_seed(ref)
    if not seed:
        raise KeyError(f"no seed {ref}")
    return seed


def compost_seed(seed_ref: str, reason: str = "moved to compost by user", auto: bool = False) -> CompostItem:
    """Move a seed to compost (it is moved, not lost: the seed row stays with state=composted)."""
    seed = _seed(seed_ref)
    flower = db.latest_flower(seed.id)
    item = CompostItem(
        id=db.new_id("cmp"), title=seed.title, summary=(flower.idea if flower else seed.prompt)[:800],
        takeaways=[f.text for f in flower.findings][:5] if flower else [], tags=seed.technologies[:6],
        technologies=seed.technologies, origin="seed", seed_id=seed.id, why_interesting=reason, processed=True,
        source="greenhouse", date=seed.created[:10],
    )
    db.put_compost(item)
    seed.state = SeedState.composted
    db.put_seed(seed)
    if auto:
        preferences.record("auto_compost", "seed", seed.id, preferences.features_of(seed))
    db.log_activity("compost", f"Seed “{seed.title}” moved to compost: {reason}", seed.id)
    return item


def auto_compost(now: datetime | None = None) -> list[str]:
    """Seeds at lowest priority (1) for longer than the profile threshold fall back into compost."""
    days = profile.load().compost_after_days
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    moved = []
    for seed in db.list_seeds():
        if seed.priority != 1 or seed.state in (SeedState.picked, SeedState.growing):
            continue
        since = datetime.fromisoformat(seed.priority_since)
        if since < cutoff:
            compost_seed(seed.id, f"lowest priority for more than {days} days", auto=True)
            moved.append(seed.id)
    return moved


# ---------------------------------------------------------------------------
# Direction actions (graph / flower panel / chat)
# ---------------------------------------------------------------------------


def direction_action(node_id: str, action: str, note: str = "") -> dict[str, Any]:
    node = db.get_node(node_id)
    if not node or node.kind.value != "direction":
        raise KeyError(f"no direction {node_id}")
    feats = {"tags": node.data.get("technologies", []), "technologies": node.data.get("technologies", []),
             "title": node.title}
    if action == "boost":
        node.data["boost"] = True
        if node.status == NodeStatus.pruned:
            node.status, node.reason = NodeStatus.active, "restored by you"
            node.data.pop("user_pruned", None)
        preferences.record("boost", "direction", node.id, feats)
    elif action == "prune":
        node.status, node.reason = NodeStatus.pruned, note or "pruned by you"
        node.data["user_pruned"] = True
        node.data.pop("boost", None)
        preferences.record("prune", "direction", node.id, feats)
    elif action == "deepen":
        node.data["user_deepen"] = note or "go deeper"
        node.data["boost"] = True
        preferences.record("boost", "direction", node.id, feats)
    elif action == "restore":
        node.status, node.reason = NodeStatus.active, "restored by you"
        node.data.pop("user_pruned", None)
    else:
        raise ValueError(f"unknown action {action}")
    db.put_node(node)
    db.log_activity("steer", f"{action.capitalize()} “{node.title}”" + (f": {note}" if note else ""), node.seed_id)
    return node.model_dump()


# ---------------------------------------------------------------------------
# Live chat
# ---------------------------------------------------------------------------


def chat_history(seed_id: str, limit: int = 60) -> list[dict[str, Any]]:
    rows = db.q("SELECT * FROM chat WHERE seed_id=? ORDER BY id DESC LIMIT ?", (seed_id, limit))
    return [{**dict(r), "actions": json.loads(r["actions"])} for r in rows][::-1]


def chat(seed_ref: str, message: str, model: str | None = None, skills_on: list[str] | None = None,
         ctx_items: list[dict[str, str]] | None = None, effort: str | None = None) -> dict[str, Any]:
    from . import composer
    from . import context as ctxmod

    seed = _seed(seed_ref)
    for it in ctx_items or []:
        attach_context(seed.id, it)
    seed = _seed(seed.id)
    skill = composer.pick(skills_on)
    db.ex("INSERT INTO chat(seed_id, role, content, actions, created) VALUES (?,?,?,?,?)",
          (seed.id, "user", message or composer.label(skill),
           json.dumps([{"type": "skills", "skills": [skill]}] if skill else []), now_iso()))
    attached = ctxmod.resolve([{"kind": "compost", "id": i} for i in seed.compost_ids][-8:]
                              + [{"kind": "feed", "id": i} for i in seed.feed_ids][-8:]
                              + [{"kind": "file", "id": i} for i in seed.attachment_ids][-8:])
    if skill:
        if skill == composer.LOOP_SKILL:
            if message:
                steer(seed.id, message)
            out = {"reply": "Starting a research round on this seed.",
                   "actions": [{"type": "run_round", "target": "", "note": message, "ok": True}]}
        else:
            out = composer.run(skill, composer.Scope(
                message=message, title=seed.title, seed=seed, context_items=attached, model=model, effort=effort,
                conversation=[{"role": m["role"], "content": m["content"]} for m in chat_history(seed.id, 16)
                              if m["role"] in ("user", "assistant")]))
        db.ex("INSERT INTO chat(seed_id, role, content, actions, created) VALUES (?,?,?,?,?)",
              (seed.id, "assistant", out["reply"], json.dumps(out["actions"]), now_iso()))
        return out
    flower = db.latest_flower(seed.id)
    dirs = db.list_nodes(seed.id, "direction")
    context = {
        "seed": loop._seed_brief(seed), "profile": profile.brief(),
        "flower": flower.model_dump(exclude={"visuals", "schema_version"}) if flower else None,
        "directions": [loop._dir_brief(d) for d in dirs],
        "recent_sources": [loop._src_brief(s) for s in loop._kept_sources(seed.id, 12)],
        "attached": attached,
        "conversation": [{"role": m["role"], "content": m["content"]} for m in chat_history(seed.id, 16)],
    }
    reply = gateway.complete(
        gateway.Call(step="chat", seed_id=seed.id, model=model, effort=effort,
                     hints={"topic": seed.title[:40], "refs": [d.id for d in dirs[:1]]}),
        skills.system_prompt("chat"), loop.render_context(context) + "\n\nUser: " + message, ChatReply,
    )
    applied = apply_chat_actions(seed, reply)
    db.ex("INSERT INTO chat(seed_id, role, content, actions, created) VALUES (?,?,?,?,?)",
          (seed.id, "assistant", reply.reply, json.dumps(applied), now_iso()))
    return {"reply": reply.reply, "actions": applied}


def attach_context(seed_id: str, item: dict[str, str]) -> Seed:
    """Drag a compost / feed item into a seed: it becomes part of the seed's grounding."""
    seed = _seed(seed_id)
    kind, ref = item.get("kind"), item.get("id", "")
    if kind == "compost" and ref not in seed.compost_ids and db.get_compost(ref):
        seed.compost_ids.append(ref)
        preferences.record("attach", "compost", ref, preferences.features_of(db.get_compost(ref)))
    elif kind == "feed" and ref not in seed.feed_ids and (f := db.get_feed_item(ref)):
        seed.feed_ids.append(ref)
        preferences.record("attach", "feed", ref, preferences.features_of(f))
    elif kind == "file" and ref not in seed.attachment_ids and db.get_attachment(ref):
        seed.attachment_ids.append(ref)
    else:
        return seed
    db.put_seed(seed)
    db.log_activity("seed", f"Added to context: {item.get('title') or ref}", seed.id)
    return seed


def detach_context(seed_id: str, kind: str, ref: str) -> Seed:
    seed = _seed(seed_id)
    if kind == "compost":
        seed.compost_ids = [x for x in seed.compost_ids if x != ref]
    elif kind == "feed":
        seed.feed_ids = [x for x in seed.feed_ids if x != ref]
    elif kind == "file":
        seed.attachment_ids = [x for x in seed.attachment_ids if x != ref]
    return db.put_seed(seed)


def stage(seed: Seed) -> dict[str, Any]:
    """Florist's judgement of where a seed is: seed → growing → flower."""
    flower = db.latest_flower(seed.id)
    if not flower:
        return {"stage": "seed", "why": "not explored yet"}
    if seed.state.value == "picked" or (flower.version >= 2 and flower.stability >= loop.STABLE_AT):
        return {"stage": "flower", "why": f"flower stable ({flower.stability:.2f})" if seed.state.value != "picked" else "picked"}
    return {"stage": "growing", "why": f"flower v{flower.version} still changing ({flower.stability:.2f})"}


def apply_chat_actions(seed: Seed, reply: ChatReply) -> list[dict[str, Any]]:
    applied = []
    for a in reply.actions:
        try:
            if a.type == "steer":
                steer(seed.id, a.note or a.target)
            elif a.type in ("prune", "boost", "deepen"):
                direction_action(a.target, a.type, a.note)
            elif a.type == "add_constraint":
                s = _seed(seed.id)
                s.constraints.notes = (s.constraints.notes + "; " if s.constraints.notes else "") + (a.target or a.note)
                db.put_seed(s)
            elif a.type == "set_tier":
                update_seed(seed.id, {"tier": a.target})
            elif a.type == "run_round":
                pass  # the caller (server/CLI) decides whether to start a round
            else:
                continue
            applied.append({**a.model_dump(), "ok": True})
        except (KeyError, ValueError) as e:
            applied.append({**a.model_dump(), "ok": False, "error": str(e)})
    return applied


def steer(seed_id: str, note: str) -> None:
    """A steering note for the next round (consumed when the round completes)."""
    db.ex("INSERT INTO chat(seed_id, role, content, created) VALUES (?,?,?,?)", (seed_id, "steer", note, now_iso()))
    db.log_activity("steer", f"Steering note: {note}", seed_id)


def inject_idea(seed_ref: str, idea: str) -> dict[str, Any]:
    """Another idea mid-search: a running loop re-grounds around it; otherwise it shapes the next round."""
    seed = _seed(seed_ref)
    db.ex("INSERT INTO chat(seed_id, role, content, created) VALUES (?,?,?,?)", (seed.id, "idea", idea, now_iso()))
    run = loop.active_run(seed.id)
    live = bool(run and run["status"] in ("running", "waiting"))
    db.log_activity("idea", f"New idea: {idea}", seed.id)
    preferences.record("steer", "seed", seed.id, {"tags": [], "technologies": [], "title": idea})
    return {"applied": "live" if live else "next_round"}
