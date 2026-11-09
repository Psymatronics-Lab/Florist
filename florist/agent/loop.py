"""The exploration loop (spec section 6) as a resumable state machine.

One round::

    ground → search* → triage → explore → check_search* → check → smoke → exploit
          → visualize → render* → flower                         (* = code steps)

LLM steps have a ``prepare`` (context + mock hints) and an ``apply`` (validate refs, write the
graph). Two drivers share them:

* **internal** — Florist calls the model gateway (API model, Claude Code or Codex subscription);
* **agent**    — an external coding agent is the brain: ``next_task`` hands it the skill,
  context and JSON Schema; ``submit`` validates its output and advances the loop.

All state lives in SQLite (``runs.state``), so a round can be resumed across processes and
the UI sees progress through the activity log.
"""

from __future__ import annotations

import json
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from .. import config, gateway, profile, research, skills, text
from ..schemas import (
    STEP_OUTPUTS,
    CheckOutput,
    ConceptSpec,
    ExploitOutput,
    ExplorationNode,
    ExploreOutput,
    Flower,
    FlowerDraft,
    GroundPlan,
    GroundTriage,
    NodeKind,
    NodeStatus,
    Seed,
    SeedState,
    SmokeOutput,
    Tier,
    now_iso,
)
from ..store import db
from . import preferences, smoke, visuals

STEPS = ["ground", "search", "triage", "explore", "check_search", "check", "smoke", "exploit",
         "visualize", "render", "flower"]
CODE_STEPS = {"search", "check_search", "render"}

TIER_DEPTH: dict[str, dict[str, Any]] = {
    "exploration": {"hits": 5, "check_queries": 1, "check_hits": 4, "crowd": False, "keep": 3, "recent": False},
    "personal": {"hits": 6, "check_queries": 2, "check_hits": 5, "crowd": True, "keep": 2, "recent": False},
    "formal": {"hits": 7, "check_queries": 3, "check_hits": 6, "crowd": True, "keep": 2, "recent": True},
}
OVERALL_WEIGHTS = {
    "exploration": {"interest": 0.4, "feasibility": 0.3, "novelty": 0.1, "room": 0.2},
    "personal": {"feasibility": 0.35, "interest": 0.3, "novelty": 0.2, "room": 0.15},
    "formal": {"novelty": 0.35, "feasibility": 0.25, "room": 0.2, "interest": 0.2},
}
STABLE_AT = 0.85


class StepRejected(ValueError):
    """Output parsed but failed semantic checks (unknown ids, findings without evidence...)."""


class RunBusy(RuntimeError):
    pass


@dataclass
class Ctx:
    seed: Seed
    run_id: str
    mode: str
    state: dict[str, Any]
    log: Callable[[str, dict[str, Any] | None], None] = field(default=lambda m, d=None: None)

    @property
    def rnd(self) -> int:
        return int(self.state.get("round", 1))

    @property
    def tier(self) -> str:
        return self.seed.tier.value

    @property
    def depth(self) -> dict[str, Any]:
        return TIER_DEPTH[self.tier]


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


def _row(run_id: str) -> dict[str, Any]:
    r = db.q1("SELECT * FROM runs WHERE id=?", (run_id,))
    if not r:
        raise KeyError(f"no run {run_id}")
    d = dict(r)
    d["state"] = json.loads(d["state"])
    return d


def active_run(seed_id: str) -> dict[str, Any] | None:
    r = db.q1("SELECT id FROM runs WHERE seed_id=? AND status IN ('running','waiting') ORDER BY started DESC LIMIT 1",
              (seed_id,))
    return _row(r["id"]) if r else None


def list_runs(seed_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.q("SELECT id FROM runs WHERE seed_id=? ORDER BY started DESC LIMIT ?", (seed_id, limit))
    return [_row(r["id"]) for r in rows]


def _save(ctx: Ctx, status: str | None = None, step: str | None = None, error: str | None = None) -> None:
    sets, params = ["state=?", "round=?"], [json.dumps(ctx.state), ctx.rnd]
    if status:
        sets.append("status=?")
        params.append(status)
        if status in ("done", "stopped", "failed"):
            sets.append("finished=?")
            params.append(now_iso())
    if step is not None:
        sets.append("step=?")
        params.append(step)
    if error is not None:
        sets.append("error=?")
        params.append(error)
    db.ex(f"UPDATE runs SET {', '.join(sets)} WHERE id=?", (*params, ctx.run_id))


def request_stop(seed_id: str) -> bool:
    run = active_run(seed_id)
    if not run:
        return False
    db.ex("UPDATE runs SET stop_requested=1 WHERE id=?", (run["id"],))
    if run["status"] == "waiting":  # agent-driven run waiting on a submission: stop right away
        db.ex("UPDATE runs SET status='stopped', finished=? WHERE id=?", (now_iso(), run["id"]))
    db.log_activity("run", "Stop requested", seed_id)
    return True


def start(seed_ref: str, rounds: int = 1, mode: str = "live") -> Ctx:
    seed = db.get_seed(seed_ref)
    if not seed:
        raise KeyError(f"no seed {seed_ref}")
    existing = active_run(seed.id)
    if existing:
        if existing["status"] == "running" and existing["mode"] != "agent":
            raise RunBusy(f"seed {seed.slug} already has a running loop ({existing['id']})")
        db.ex("UPDATE runs SET status='stopped', finished=? WHERE id=?", (now_iso(), existing["id"]))
    run_id = db.new_id("run")
    state = {"round": seed.rounds_done + 1, "first_round": seed.rounds_done + 1,
             "last_round": seed.rounds_done + max(1, rounds), "step_idx": 0}
    db.ex("INSERT INTO runs(id, seed_id, mode, status, round, step, state, started) VALUES (?,?,?,?,?,?,?,?)",
          (run_id, seed.id, mode, "running", state["round"], STEPS[0], json.dumps(state), now_iso()))
    if seed.state in (SeedState.dormant, SeedState.candidate, SeedState.composted):
        seed.state = SeedState.growing
        db.put_seed(seed)
    ensure_root(seed)
    db.log_activity("run", f"Exploration started ({mode}, {rounds} round{'s' if rounds != 1 else ''})", seed.id,
                    {"run_id": run_id})
    return _ctx(seed, run_id, mode, state)


def _ctx(seed: Seed, run_id: str, mode: str, state: dict[str, Any]) -> Ctx:
    def log(msg: str, data: dict[str, Any] | None = None) -> None:
        db.log_activity("loop", msg, seed.id, {"run_id": run_id, "round": state.get("round"), **(data or {})})

    return Ctx(seed=seed, run_id=run_id, mode=mode, state=state, log=log)


def load_ctx(run_id: str) -> Ctx:
    r = _row(run_id)
    seed = db.get_seed(r["seed_id"])
    if not seed:
        raise KeyError(r["seed_id"])
    return _ctx(seed, run_id, r["mode"], r["state"])


def ensure_root(seed: Seed) -> None:
    root = db.get_node(seed.id)
    node = ExplorationNode(id=seed.id, seed_id=seed.id, round=0, kind=NodeKind.seed, title=seed.title,
                           summary=seed.prompt[:400], data={"tier": seed.tier.value})
    if root:
        node.created = root.created
    db.put_node(node)


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------


def grow(seed_ref: str, rounds: int = 1, mode: str = "live", model: str | None = None) -> dict[str, Any]:
    """Internal driver: run ``rounds`` full rounds with the model gateway."""
    ctx = start(seed_ref, rounds, mode)
    return drive(ctx, model=model)


def drive(ctx: Ctx, model: str | None = None) -> dict[str, Any]:
    try:
        while True:
            if _stop_requested(ctx):
                return _finish(ctx, "stopped", "stopped by user")
            check_new_ideas(ctx)
            step = STEPS[ctx.state["step_idx"]]
            _save(ctx, status="running", step=step)
            if step in CODE_STEPS:
                CODE[step](ctx)
            else:
                task = prepare(ctx, step)
                if task is None:
                    ctx.log(f"Skipped {step}", {"step": step})
                else:
                    _run_llm_step(ctx, step, task, model)
            done = _advance(ctx)
            if done:
                return done
    except gateway.BudgetExceeded as e:
        return _finish(ctx, "stopped", str(e))
    except Exception as e:
        ctx.log(f"Loop failed at {STEPS[ctx.state['step_idx']]}: {e}", {"error": traceback.format_exc()[-2000:]})
        _save(ctx, status="failed", error=str(e)[:2000])
        raise


def _run_llm_step(ctx: Ctx, step: str, task: dict[str, Any], model: str | None) -> None:
    schema = STEP_OUTPUTS[step]
    call = gateway.Call(step=step, seed_id=ctx.seed.id, run_id=ctx.run_id, model=model,
                        hints=task.get("hints", {}), max_usd=ctx.seed.budget.max_usd)
    system = skills.system_prompt(step)
    user = render_context(task["context"])
    for attempt in range(2):
        out = gateway.complete(call, system, user, schema)
        try:
            apply(ctx, step, out)
            return
        except StepRejected as e:
            if attempt == 1:
                raise
            ctx.log(f"{step}: output rejected ({e}); asking again", {"step": step})
            user = render_context(task["context"]) + f"\n\n---\nYour previous answer was rejected: {e}\nFix it."


def render_context(context: dict[str, Any]) -> str:
    return "## Context\n\n```json\n" + json.dumps(context, indent=1, ensure_ascii=False, default=str) + "\n```"


def _advance(ctx: Ctx) -> dict[str, Any] | None:
    ctx.state["step_idx"] += 1
    if ctx.state["step_idx"] < len(STEPS):
        _save(ctx)
        return None
    # Round complete.
    seed = db.get_seed(ctx.seed.id) or ctx.seed
    seed.rounds_done = ctx.rnd
    if seed.state in (SeedState.dormant, SeedState.growing):
        seed.state = SeedState.flowering if db.latest_flower(seed.id) else SeedState.growing
    db.put_seed(seed)
    ctx.seed = seed
    db.ex("UPDATE chat SET consumed=1 WHERE seed_id=? AND role IN ('steer','idea')", (seed.id,))
    flower = db.latest_flower(seed.id)
    usd = gateway.spent(run_id=ctx.run_id)
    ctx.log(f"Round {ctx.rnd} complete", {"stability": flower.stability if flower else 0, "usd": usd})
    if flower and ctx.rnd >= 2 and flower.stability >= STABLE_AT:
        return _finish(ctx, "done", f"flower stable ({flower.stability:.2f})")
    if gateway.spent(seed_id=seed.id) >= seed.budget.max_usd:
        return _finish(ctx, "done", "seed budget used up")
    if ctx.rnd >= ctx.state["last_round"]:
        return _finish(ctx, "done", "requested rounds complete")
    ctx.state["round"] = ctx.rnd + 1
    ctx.state["step_idx"] = 0
    for k in ("new_sources", "round_directions", "closest", "crowd", "to_check"):
        ctx.state.pop(k, None)
    _save(ctx)
    return None


def _finish(ctx: Ctx, status: str, reason: str) -> dict[str, Any]:
    ctx.state["reason"] = reason
    _save(ctx, status=status, step="")
    ctx.log(f"Exploration {status}: {reason}", {"status": status})
    return {"run_id": ctx.run_id, "seed_id": ctx.seed.id, "status": status, "reason": reason, "round": ctx.rnd,
            "usd": round(gateway.spent(run_id=ctx.run_id), 4)}


def check_new_ideas(ctx: Ctx) -> bool:
    """On-the-fly change: a new idea arrived mid-run → re-ground this round around it (once per round)."""
    row = db.q1("SELECT MAX(id) m FROM chat WHERE seed_id=? AND role='idea' AND consumed=0", (ctx.seed.id,))
    newest = int(row["m"] or 0) if row else 0
    if newest <= int(ctx.state.get("ideas_seen", 0)):
        return False
    ctx.state["ideas_seen"] = newest
    if ctx.state["step_idx"] == 0 or ctx.state.get("regrounded_round") == ctx.rnd:
        ctx.log("New idea noted — it shapes the next steps", {"step": "idea"})
        return False
    ctx.state["regrounded_round"] = ctx.rnd
    ctx.state["step_idx"] = 0
    ctx.log("New idea received mid-search — re-grounding this round around it", {"step": "idea"})
    _save(ctx)
    return True


def _stop_requested(ctx: Ctx) -> bool:
    r = db.q1("SELECT stop_requested FROM runs WHERE id=?", (ctx.run_id,))
    return bool(r and r["stop_requested"])


# --- agent driver -----------------------------------------------------------


def next_task(seed_ref: str | None = None, run_id: str | None = None) -> dict[str, Any]:
    """Agent driver: run code steps until the next model step and return it as a task."""
    if run_id is None:
        seed = db.get_seed(seed_ref or "")
        if not seed:
            raise KeyError(f"no seed {seed_ref}")
        run = active_run(seed.id)
        if not run or run["mode"] != "agent":
            raise KeyError(f"no agent run for {seed.slug}; start one with `florist round start {seed.slug}`")
        run_id = run["id"]
    ctx = load_ctx(run_id)
    r = _row(run_id)
    if r["status"] in ("done", "stopped", "failed"):
        return {"run_id": run_id, "status": r["status"], "reason": ctx.state.get("reason", r["error"])}
    if ctx.state.get("pending"):
        return ctx.state["pending"]
    while True:
        if _stop_requested(ctx):
            return _finish(ctx, "stopped", "stopped by user")
        check_new_ideas(ctx)
        step = STEPS[ctx.state["step_idx"]]
        _save(ctx, status="running", step=step)
        if step in CODE_STEPS:
            CODE[step](ctx)
        else:
            task = prepare(ctx, step)
            if task is not None:
                schema = STEP_OUTPUTS[step]
                pending = {
                    "run_id": ctx.run_id, "seed_id": ctx.seed.id, "seed": ctx.seed.slug, "round": ctx.rnd,
                    "step": step, "skill": skills.for_step(step).name, "output_schema": schema.__name__,
                    "instructions": skills.system_prompt(step), "context": task["context"],
                    "schema": gateway.inline_schema(schema),
                    "submit": f"florist round submit {ctx.seed.slug} --file <output.json>",
                }
                ctx.state["pending"] = pending
                _save(ctx, status="waiting", step=step)
                ctx.log(f"Waiting for agent: {step}", {"step": step})
                return pending
            ctx.log(f"Skipped {step}", {"step": step})
        done = _advance(ctx)
        if done:
            return done


def submit(seed_ref: str, data: dict[str, Any] | str) -> dict[str, Any]:
    """Agent driver: validate the agent's output for the pending step, apply it, return the next task."""
    seed = db.get_seed(seed_ref)
    if not seed:
        raise KeyError(f"no seed {seed_ref}")
    run = active_run(seed.id)
    if not run or not run["state"].get("pending"):
        raise KeyError("no pending step for this seed")
    ctx = load_ctx(run["id"])
    step = ctx.state["pending"]["step"]
    schema = STEP_OUTPUTS[step]
    payload = json.loads(data) if isinstance(data, str) else data
    try:
        out = schema.model_validate(payload)
        apply(ctx, step, out)
    except (ValidationError, StepRejected) as e:
        msg = gateway._short_error(e) if isinstance(e, ValidationError) else str(e)
        return {"accepted": False, "step": step, "error": msg, "hint": "fix the output and submit again"}
    ctx.state.pop("pending", None)
    gateway._log(gateway.Call(step=step, seed_id=seed.id, run_id=ctx.run_id), "agent:external",
                 gateway.Raw(text=""), 0, ok=True)
    done = _advance(ctx)
    if done:
        return {"accepted": True, "step": step, "next": done}
    _save(ctx)
    return {"accepted": True, "step": step, "next": next_task(run_id=ctx.run_id)}


# ---------------------------------------------------------------------------
# Context helpers
# ---------------------------------------------------------------------------


def _seed_brief(seed: Seed) -> dict[str, Any]:
    return {
        "id": seed.id, "title": seed.title, "prompt": seed.prompt, "tier": seed.tier.value,
        "technologies": seed.technologies, "related_papers": seed.related_papers,
        "constraints": seed.constraints.model_dump(), "followups": [f.model_dump() for f in seed.followups if f.answer],
        "conference_targets": seed.conference_targets, "deadline": seed.deadline,
        "spec_sheet": _spec_text(seed),
    }


def _spec_text(seed: Seed) -> str:
    """The seed's single-source spec sheet (user-editable markdown), if it says more than the template."""
    from . import seedspec

    text = seedspec.read(seed)
    return text[:4000] if seedspec.is_customized(seed, text) else ""


def _steering(seed_id: str) -> dict[str, Any]:
    notes = [r["content"] for r in db.q("SELECT content FROM chat WHERE seed_id=? AND role='steer' AND consumed=0",
                                        (seed_id,))]
    boosted, user_pruned, deepen = [], [], []
    for d in db.list_nodes(seed_id, "direction"):
        if d.data.get("boost"):
            boosted.append(d.id)
        if d.data.get("user_pruned"):
            user_pruned.append({"id": d.id, "reason": d.reason})
        if d.data.get("user_deepen"):
            deepen.append({"id": d.id, "note": d.data["user_deepen"]})
    ideas = [r["content"] for r in db.q("SELECT content FROM chat WHERE seed_id=? AND role='idea' AND consumed=0",
                                         (seed_id,))]
    return {"notes": notes, "new_ideas": ideas, "boosted": boosted, "user_pruned": user_pruned,
            "user_deepen": deepen}


def _dir_brief(d: ExplorationNode, full: bool = False) -> dict[str, Any]:
    out = {"id": d.id, "title": d.title, "status": d.status.value, "round": d.round,
           "description": d.data.get("description", d.summary)}
    if d.data.get("scores"):
        out["scores"] = d.data["scores"]
    if d.data.get("deepen"):
        out["deepen"] = d.data["deepen"]
    if d.status == NodeStatus.pruned:
        out["pruned_reason"] = d.reason
    if full:
        out.update({k: d.data.get(k) for k in ("framing", "technologies", "scope") if d.data.get(k)})
        chk = d.data.get("check") or {}
        if chk:
            out["check"] = {k: chk.get(k) for k in ("closest_work", "gap", "feasibility_notes", "risks", "crowd",
                                                     "check_node")}
    return out


def _src_brief(n: ExplorationNode, abstract: int = 0) -> dict[str, Any]:
    out = {"id": n.id, "title": n.title, "kind": n.data.get("kind", "paper"), "year": n.data.get("year"),
           "summary": n.summary or n.data.get("abstract", "")[:240]}
    if abstract:
        out["abstract"] = (n.data.get("abstract") or "")[:abstract]
    for k in ("venue", "citations", "stars", "url"):
        if n.data.get(k):
            out[k] = n.data[k]
    return out


def _kept_sources(seed_id: str, limit: int = 24) -> list[ExplorationNode]:
    srcs = [s for s in db.list_nodes(seed_id, "source") if s.status != NodeStatus.pruned]
    return sorted(srcs, key=lambda s: -(s.score or 0))[:limit]


def _hints(ctx: Ctx, refs: list[str] | None = None, evidence: list[str] | None = None) -> dict[str, Any]:
    words = text.tokens(ctx.seed.title + " " + " ".join(ctx.seed.technologies))[:6]
    return {"topic": ctx.seed.title[:40], "refs": refs or [], "evidence": evidence or [], "words": words or None,
            "round": ctx.rnd}


# ---------------------------------------------------------------------------
# prepare / apply per LLM step
# ---------------------------------------------------------------------------


def prepare(ctx: Ctx, step: str) -> dict[str, Any] | None:
    return PREPARE[step](ctx)


def apply(ctx: Ctx, step: str, out: BaseModel) -> None:
    APPLY[step](ctx, out)


# --- ground ----------------------------------------------------------------


def prep_ground(ctx: Ctx) -> dict[str, Any]:
    seed = ctx.seed
    flower = db.latest_flower(seed.id)
    compost = [c for c in (db.get_compost(i) for i in seed.compost_ids) if c]
    feed = [f for f in (db.get_feed_item(i) for i in seed.feed_ids) if f]
    files = [a for a in (db.get_attachment(i) for i in seed.attachment_ids) if a]
    tops = db.list_nodes(seed.id, "direction", "top")
    context = {
        "round": ctx.rnd, "seed": _seed_brief(seed), "profile": profile.brief(),
        "linked_compost": [{"title": c.title, "summary": c.summary, "tags": c.tags} for c in compost],
        "linked_feed": [{"title": f.title, "summary": f.summary or f.content[:300]} for f in feed],
        "attached_files": [{"title": a.name, "excerpt": a.text[:1500]} for a in files],
        "previous_flower": flower.model_dump(include={"idea", "open_questions", "risks"}) if flower else None,
        "top_directions": [_dir_brief(d) for d in tops],
        "steering": _steering(seed.id),
        "queries_already_run": json.loads(db.kv_get(f"queries:{seed.id}", "[]"))[-30:],
    }
    return {"context": context, "hints": _hints(ctx)}


def apply_ground(ctx: Ctx, out: GroundPlan) -> None:
    done = set(q.lower() for q in json.loads(db.kv_get(f"queries:{ctx.seed.id}", "[]")))
    queries = [q.model_dump() for q in out.queries if q.query.lower() not in done]
    if not queries:
        queries = [q.model_dump() for q in out.queries]
    ctx.state["queries"] = queries
    for tech in out.technologies[:8]:
        db.put_node(ExplorationNode(id=db.new_id("tech"), seed_id=ctx.seed.id, round=ctx.rnd,
                                    kind=NodeKind.technology, title=tech, parents=[ctx.seed.id]),
                    dedupe_key=f"tech:{tech.lower()}")
    ctx.log(f"Planned {len(queries)} searches", {"step": "ground", "queries": [q["query"] for q in queries]})


# --- search (code) ----------------------------------------------------------


def _source_node(ctx: Ctx, hit: research.Hit, parent: str, query: str) -> tuple[ExplorationNode, bool]:
    node = ExplorationNode(
        id=db.new_id("src"), seed_id=ctx.seed.id, round=ctx.rnd, kind=NodeKind.source, title=hit.title[:300],
        url=hit.url, parents=[parent],
        data={"kind": hit.kind, "tool": hit.tool, "external_id": hit.external_id, "abstract": hit.abstract,
              "year": hit.year, "published": hit.published, "authors": hit.authors, "venue": hit.venue,
              "citations": hit.citations, "stars": hit.stars, "url": hit.url, "query": query},
    )
    saved = db.put_node(node, dedupe_key=hit.key())
    if saved.id != node.id:
        db.add_edge(ctx.seed.id, parent, saved.id)
    return saved, saved.id == node.id


def do_search(ctx: Ctx) -> None:
    seed, depth = ctx.seed, ctx.depth
    new: list[str] = []
    if ctx.rnd == ctx.state.get("first_round") and seed.rounds_done == 0:
        for cid in seed.compost_ids:
            c = db.get_compost(cid)
            if c:
                n = ExplorationNode(id=db.new_id("src"), seed_id=seed.id, round=ctx.rnd, kind=NodeKind.source,
                                    title=c.title, url=(c.links or [""])[0], summary=c.summary, parents=[seed.id],
                                    score=0.8, data={"kind": "compost", "tool": "compost", "abstract": c.summary,
                                                     "compost_id": c.id, "tags": c.tags})
                saved = db.put_node(n, dedupe_key=f"compost:{c.id}")
                new.append(saved.id)
    history = json.loads(db.kv_get(f"queries:{seed.id}", "[]"))
    from datetime import date, timedelta
    recent_since = (date.today() - timedelta(days=540)).isoformat()
    for i, q in enumerate(ctx.state.get("queries", [])):
        since = recent_since if depth["recent"] and q["kind"] == "paper" and i % 2 == 1 else None
        hits = research.search(q["query"], kind=q["kind"] if q["kind"] != "any" else "paper",
                               limit=depth["hits"], since=since, log=lambda m: ctx.log(m, {"step": "search"}))
        added = 0
        for h in hits:
            node, created = _source_node(ctx, h, seed.id, q["query"])
            if created:
                new.append(node.id)
                added += 1
        history.append(q["query"])
        ctx.log(f"Searched “{q['query']}” → {len(hits)} hits ({added} new)", {"step": "search"})
    db.kv_set(f"queries:{seed.id}", json.dumps(history[-200:]))
    ctx.state["new_sources"] = new


# --- triage -----------------------------------------------------------------


def prep_triage(ctx: Ctx) -> dict[str, Any] | None:
    ids = ctx.state.get("new_sources", [])[:36]
    nodes = [n for n in (db.get_node(i) for i in ids) if n]
    if not nodes:
        return None
    context = {"seed": _seed_brief(ctx.seed), "sources": [_src_brief(n, abstract=500) for n in nodes],
               "previous_landscape": db.kv_get(f"landscape:{ctx.seed.id}")}
    return {"context": context, "hints": _hints(ctx, refs=[n.id for n in nodes])}


def apply_triage(ctx: Ctx, out: GroundTriage) -> None:
    valid = set(ctx.state.get("new_sources", []))
    kept = 0
    for note in out.notes:
        if note.ref not in valid:
            continue
        n = db.get_node(note.ref)
        if not n:
            continue
        n.summary = note.summary or n.summary
        n.score = note.relevance
        n.data["technologies"] = note.technologies
        if not note.keep or note.relevance < 0.2:
            n.status, n.reason = NodeStatus.pruned, "off-topic in triage"
        else:
            kept += 1
        db.put_node(n)
    if out.landscape:
        db.kv_set(f"landscape:{ctx.seed.id}", out.landscape)
    ctx.log(f"Triaged sources: kept {kept} of {len(valid)}", {"step": "triage"})


# --- explore ----------------------------------------------------------------


def prep_explore(ctx: Ctx) -> dict[str, Any]:
    dirs = db.list_nodes(ctx.seed.id, "direction")
    context = {
        "round": ctx.rnd, "seed": _seed_brief(ctx.seed), "profile": profile.brief(),
        "landscape": db.kv_get(f"landscape:{ctx.seed.id}"),
        "sources": [_src_brief(s) for s in _kept_sources(ctx.seed.id, 20)],
        "top_directions": [_dir_brief(d, True) for d in dirs if d.status == NodeStatus.top],
        "active_directions": [_dir_brief(d) for d in dirs if d.status == NodeStatus.active],
        "pruned_directions": [{"title": d.title, "reason": d.reason} for d in dirs if d.status == NodeStatus.pruned],
        "steering": _steering(ctx.seed.id),
    }
    return {"context": context, "hints": _hints(ctx, evidence=[s.id for s in _kept_sources(ctx.seed.id, 6)])}


def apply_explore(ctx: Ctx, out: ExploreOutput) -> None:
    existing = {d.id: d for d in db.list_nodes(ctx.seed.id, "direction")}
    sources = {s.id for s in db.list_nodes(ctx.seed.id, "source")}
    seen_titles = {d.title.lower() for d in existing.values()}
    created = []
    for p in out.directions:
        if p.title.lower() in seen_titles:
            continue
        parent = p.evolves if p.evolves in existing else ctx.seed.id
        node = ExplorationNode(
            id=db.new_id("dir"), seed_id=ctx.seed.id, round=ctx.rnd, kind=NodeKind.direction, title=p.title,
            summary=p.description[:400], parents=[parent],
            data={"description": p.description, "framing": p.framing, "technologies": p.technologies,
                  "scope": p.scope, "evolves": p.evolves if p.evolves in existing else "",
                  "inspired_by": [s for s in p.inspired_by if s in sources]},
        )
        db.put_node(node)
        for s in node.data["inspired_by"]:
            db.add_edge(ctx.seed.id, s, node.id, "inspired")
        created.append(node.id)
        seen_titles.add(p.title.lower())
    if not created:
        raise StepRejected("no new directions (all duplicated existing titles)")
    ctx.state["round_directions"] = ctx.state.get("round_directions", []) + created
    ctx.log(f"Proposed {len(created)} directions", {"step": "explore"})


# --- check_search (code) ----------------------------------------------------


def do_check_search(ctx: Ctx) -> None:
    depth = ctx.depth
    tops = [d.id for d in db.list_nodes(ctx.seed.id, "direction", "top")]
    to_check = list(dict.fromkeys(ctx.state.get("round_directions", []) + tops))
    closest: dict[str, list[str]] = {}
    crowd: dict[str, Any] = {}
    from datetime import date, timedelta
    recent_since = (date.today() - timedelta(days=540)).isoformat()
    for did in to_check:
        d = db.get_node(did)
        if not d:
            continue
        techs = " ".join(d.data.get("technologies", [])[:3])
        phrase = d.title if len(d.title.split()) >= 3 else f"{d.title} {techs}"
        plans: list[tuple[str, str, str | None]] = [(phrase, "paper", None)]
        if depth["check_queries"] >= 2:
            plans.append((f"{d.title} {techs}".strip(), "repo", None))
        if depth["check_queries"] >= 3:
            plans.append((phrase, "paper", recent_since))
        ids: list[str] = []
        for query, kind, since in plans:
            hits = research.search(query, kind=kind, limit=depth["check_hits"], since=since,
                                   log=lambda m: ctx.log(m, {"step": "check_search"}))
            for h in hits:
                node, _ = _source_node(ctx, h, did, query)
                db.add_edge(ctx.seed.id, did, node.id, "closest")
                ids.append(node.id)
        closest[did] = list(dict.fromkeys(ids))
        if depth["crowd"]:
            crowd[did] = research.crowdedness(" ".join(text.tokens(phrase)[:5]) or phrase)
        ctx.log(f"Closest-work search for “{d.title}”: {len(closest[did])} candidates", {"step": "check_search"})
    ctx.state["to_check"] = to_check
    ctx.state["closest"] = closest
    ctx.state["crowd"] = crowd


# --- check ------------------------------------------------------------------


def prep_check(ctx: Ctx) -> dict[str, Any] | None:
    to_check = [d for d in (db.get_node(i) for i in ctx.state.get("to_check", [])) if d]
    if not to_check:
        return None
    entries, evidence = [], []
    for d in to_check:
        cands = [n for n in (db.get_node(i) for i in ctx.state.get("closest", {}).get(d.id, [])) if n]
        evidence += [c.id for c in cands]
        entries.append({**_dir_brief(d, True), "closest_candidates": [_src_brief(c, abstract=350) for c in cands],
                        "crowdedness_counts": ctx.state.get("crowd", {}).get(d.id)})
    context = {"tier": ctx.tier, "seed": _seed_brief(ctx.seed), "profile": profile.brief(), "directions": entries}
    return {"context": context, "hints": _hints(ctx, refs=[d.id for d in to_check], evidence=evidence)}


def overall(tier: str, s: dict[str, float], boost: bool = False) -> float:
    w = OVERALL_WEIGHTS[tier]
    val = (w["novelty"] * s["novelty"] + w["feasibility"] * s["feasibility"]
           + w["room"] * (1 - s["crowdedness"]) + w["interest"] * s["interest"])
    return round(min(1.0, val + (0.1 if boost else 0.0)), 3)


def apply_check(ctx: Ctx, out: CheckOutput) -> None:
    valid = set(ctx.state.get("to_check", []))
    sources = {s.id for s in db.list_nodes(ctx.seed.id, "source")}
    seen = set()
    for c in out.checks:
        if c.ref not in valid or c.ref in seen:
            continue
        seen.add(c.ref)
        d = db.get_node(c.ref)
        if not d:
            continue
        feats = {"tags": d.data.get("technologies", []), "technologies": d.data.get("technologies", []),
                 "title": d.title, "tier": ctx.tier}
        pref = preferences.score(feats)
        interest = c.interest if abs(pref - 0.5) < 1e-6 else round(0.5 * c.interest + 0.5 * pref, 3)
        scores = {"novelty": c.novelty, "feasibility": c.feasibility, "crowdedness": c.crowdedness,
                  "interest": interest, "interest_model": c.interest, "interest_learned": pref}
        scores["overall"] = overall(ctx.tier, scores, bool(d.data.get("boost")))
        closest = [cw.model_dump() for cw in c.closest_work if cw.ref in sources]
        for cw in closest:
            if not cw.get("title"):
                src = db.get_node(cw["ref"])
                cw["title"] = src.title if src else ""
        chk = ExplorationNode(
            id=db.new_id("chk"), seed_id=ctx.seed.id, round=ctx.rnd, kind=NodeKind.check,
            title=f"Check: {d.title[:50]}", parents=[d.id], score=scores["overall"],
            summary=(f"novelty {c.novelty:.2f} · feasibility {c.feasibility:.2f} · crowded {c.crowdedness:.2f} · "
                     f"interest {interest:.2f}. Gap: {c.gap or '—'}"),
            data={"scores": scores, "closest_work": closest, "gap": c.gap, "feasibility_notes": c.feasibility_notes,
                  "risks": c.risks, "smoke_worthy": c.smoke_worthy, "crowd": ctx.state.get("crowd", {}).get(d.id)},
        )
        db.put_node(chk)
        for cw in closest:
            db.add_edge(ctx.seed.id, cw["ref"], chk.id, "evidence")
        d.data["scores"] = scores
        d.data["check"] = {**chk.data, "check_node": chk.id}
        d.score = scores["overall"]
        db.put_node(d)
    if not seen:
        raise StepRejected("no check referenced a direction id from the context")
    missing = valid - seen
    if missing:
        ctx.log(f"Check skipped {len(missing)} direction(s)", {"step": "check"})
    ctx.log(f"Checked {len(seen)} directions for novelty and feasibility", {"step": "check"})


# --- smoke ------------------------------------------------------------------


def prep_smoke(ctx: Ctx) -> dict[str, Any] | None:
    if not config.get().smoke_enabled:
        return None
    pending = {s.direction_id for s in db.list_smoke(ctx.seed.id) if s.status in ("pending", "passed", "running")}
    cands = [d for d in db.list_nodes(ctx.seed.id, "direction") if d.status != NodeStatus.pruned
             and (d.data.get("check") or {}).get("smoke_worthy") and d.id not in pending]
    cands = sorted(cands, key=lambda d: -(d.score or 0))[:2]
    if not cands or (ctx.tier == "exploration" and ctx.rnd > 1):
        return None
    context = {"profile": profile.brief(), "seed": _seed_brief(ctx.seed),
               "directions": [{**_dir_brief(d), "smoke_worthy": d.data["check"]["smoke_worthy"]} for d in cands]}
    return {"context": context, "hints": _hints(ctx, refs=[d.id for d in cands])}


def apply_smoke(ctx: Ctx, out: SmokeOutput) -> None:
    dirs = {d.id for d in db.list_nodes(ctx.seed.id, "direction")}
    for p in out.proposals[:2]:
        if "SMOKE_RESULT" not in p.code:
            raise StepRejected("smoke code must print a SMOKE_RESULT {json} line")
        smoke.add(ctx.seed.id, p.direction_ref if p.direction_ref in dirs else "", p.assumption, p.code,
                  p.rationale, p.expected, p.timeout_s, ctx.rnd)
    if out.proposals:
        ctx.log(f"Proposed {len(out.proposals)} smoke check(s) — awaiting your approval", {"step": "smoke"})


# --- exploit ----------------------------------------------------------------


def prep_exploit(ctx: Ctx) -> dict[str, Any] | None:
    dirs = [d for d in db.list_nodes(ctx.seed.id, "direction") if d.status != NodeStatus.pruned]
    if not dirs:
        return None
    context = {"tier": ctx.tier, "max_keep": ctx.depth["keep"], "seed": _seed_brief(ctx.seed),
               "directions": [_dir_brief(d, True) for d in sorted(dirs, key=lambda d: -(d.score or 0))],
               "steering": _steering(ctx.seed.id)}
    return {"context": context, "hints": _hints(ctx, refs=[d.id for d in sorted(dirs, key=lambda d: -(d.score or 0))])}


def apply_exploit(ctx: Ctx, out: ExploitOutput) -> None:
    dirs = {d.id: d for d in db.list_nodes(ctx.seed.id, "direction") if d.status != NodeStatus.pruned}
    ranked = [r for r in sorted(out.ranking, key=lambda r: r.rank) if r.ref in dirs]
    if not ranked:
        raise StepRejected("ranking referenced no direction ids from the context")
    kept = 0
    for r in ranked:
        d = dirs[r.ref]
        d.data["rank"] = r.rank
        if r.keep and kept < ctx.depth["keep"]:
            d.status, d.reason = NodeStatus.top, r.reason
            d.data["deepen"] = d.data.pop("user_deepen", None) or r.deepen
            kept += 1
        elif r.keep:
            d.status, d.reason = NodeStatus.active, r.reason
        elif d.data.get("boost"):
            d.status, d.reason = NodeStatus.active, f"kept because you boosted it ({r.reason})"
        else:
            d.status, d.reason = NodeStatus.pruned, r.reason
            d.data["pruned_round"] = ctx.rnd
        db.put_node(d)
    if kept == 0:  # always keep the best one
        best = dirs[ranked[0].ref]
        best.status = NodeStatus.top
        db.put_node(best)
    pruned = sum(1 for r in ranked if dirs[r.ref].status == NodeStatus.pruned)
    ctx.log(f"Ranked {len(ranked)} directions: kept {max(kept, 1)}, pruned {pruned}", {"step": "exploit"})


# --- visualize --------------------------------------------------------------


def prep_visualize(ctx: Ctx) -> dict[str, Any] | None:
    tops = sorted(db.list_nodes(ctx.seed.id, "direction", "top"), key=lambda d: -(d.score or 0))
    if not tops:
        return None
    top = tops[0]
    if db.kv_get(f"concept_for:{ctx.seed.id}") == top.id:
        return None  # concept already drawn for this direction
    ctx.state["concept_dir"] = top.id
    context = {"seed": _seed_brief(ctx.seed), "direction": _dir_brief(top, True),
               "sources": [_src_brief(s) for s in _kept_sources(ctx.seed.id, 8)]}
    return {"context": context, "hints": _hints(ctx)}


def apply_visualize(ctx: Ctx, out: ConceptSpec) -> None:
    v = visuals.concept(ctx.seed.id, out, ctx.rnd)
    db.kv_set(f"concept_for:{ctx.seed.id}", ctx.state.get("concept_dir", ""))
    vis_node = ExplorationNode(id=f"visn_{ctx.seed.id[-8:]}_concept", seed_id=ctx.seed.id, round=ctx.rnd,
                               kind=NodeKind.visual, title=v.title, summary=v.caption,
                               parents=[ctx.state.get("concept_dir") or ctx.seed.id], data={"visual_id": v.id})
    db.put_node(vis_node)
    ctx.log(f"Drew concept explainer: {out.title}", {"step": "visualize"})


# --- render (code) ----------------------------------------------------------


def do_render(ctx: Ctx) -> None:
    sid = ctx.seed.id
    sources = [s for s in db.list_nodes(sid, "source") if s.status != NodeStatus.pruned]
    dirs = db.list_nodes(sid, "direction")
    visuals.landscape(sid, sources, dirs, ctx.rnd, ctx.seed.title)
    visuals.scores(sid, dirs, ctx.rnd)
    visuals.smoke(sid, db.list_smoke(sid))
    visuals.graph(sid, ctx.rnd)
    for kind in ("landscape", "scores"):
        db.put_node(ExplorationNode(id=f"visn_{sid[-8:]}_{kind}", seed_id=sid, round=ctx.rnd, kind=NodeKind.visual,
                                    title="Landscape map" if kind == "landscape" else "Direction scores",
                                    parents=[sid], data={"visual_id": f"vis_{sid[-8:]}_{kind}"}))
    ctx.log("Rendered landscape map, score chart and graph", {"step": "render"})


# --- flower -----------------------------------------------------------------


def prep_flower(ctx: Ctx) -> dict[str, Any] | None:
    sid = ctx.seed.id
    tops = sorted(db.list_nodes(sid, "direction", "top"), key=lambda d: -(d.score or 0))
    if not tops:
        tops = sorted([d for d in db.list_nodes(sid, "direction") if d.status != NodeStatus.pruned],
                      key=lambda d: -(d.score or 0))[:2]
    if not tops:
        return None
    cited: dict[str, ExplorationNode] = {}
    for d in tops:
        for cw in (d.data.get("check") or {}).get("closest_work", []):
            n = db.get_node(cw["ref"])
            if n:
                cited[n.id] = n
    for s in _kept_sources(sid, 16):
        cited.setdefault(s.id, s)
    checks = [c for c in db.list_nodes(sid, "check") if c.parents and c.parents[0] in {d.id for d in tops}]
    smokes = [s for s in db.list_smoke(sid) if s.status in ("passed", "failed")]
    prev = db.latest_flower(sid)
    context = {
        "seed": _seed_brief(ctx.seed), "profile": profile.brief(), "landscape": db.kv_get(f"landscape:{sid}"),
        "top_directions": [_dir_brief(d, True) for d in tops],
        "sources": [_src_brief(s) for s in cited.values()],
        "checks": [{"id": c.id, "direction": c.parents[0], "summary": c.summary} for c in checks[-6:]],
        "smoke_results": [{"id": s.id, "assumption": s.assumption, "status": s.status, "metrics": s.metrics,
                           "verdict": s.verdict} for s in smokes],
        "pruned_directions": [{"title": d.title, "reason": d.reason}
                              for d in db.list_nodes(sid, "direction", "pruned")][-8:],
        "previous_flower": prev.model_dump(exclude={"visuals", "schema_version"}) if prev else None,
        "steering": _steering(sid),
    }
    ctx.state["flower_tops"] = [d.id for d in tops]
    evidence = list(cited)[:8] + [c.id for c in checks[-2:]]
    return {"context": context, "hints": _hints(ctx, refs=[d.id for d in tops], evidence=evidence)}


def _valid_refs(seed_id: str) -> set[str]:
    ids = {n.id for n in db.list_nodes(seed_id) if n.kind.value in ("source", "check", "smoke")}
    ids |= {s.id for s in db.list_smoke(seed_id)}
    return ids


def apply_flower(ctx: Ctx, out: FlowerDraft) -> None:
    sid = ctx.seed.id
    valid = _valid_refs(sid)
    dir_nodes = {d.id: d for d in db.list_nodes(sid, "direction")}
    findings = []
    dropped = 0
    for f in out.findings:
        f.evidence = [e for e in f.evidence if e.ref in valid]
        if f.evidence:
            findings.append(f)
        else:
            dropped += 1
    if not findings:
        raise StepRejected("every finding lacked evidence refs that exist in the context (use src_/chk_/smk_ ids)")
    directions = []
    for d in out.directions:
        if d.node_id not in dir_nodes:
            match = max(dir_nodes.values(), key=lambda n: text.similarity(n.title, d.title), default=None)
            d.node_id = match.id if match and text.similarity(match.title, d.title) > 0.2 else ""
        directions.append(d)
    out.novelty.closest_work = [c for c in out.novelty.closest_work if c.ref in valid]
    prev = db.latest_flower(sid)
    flower = Flower(
        seed_id=sid, version=(prev.version + 1) if prev else 1, round=ctx.rnd, idea=out.idea, findings=findings,
        directions=directions, novelty=out.novelty, risks=out.risks, open_questions=out.open_questions,
        first_steps=out.first_steps, success_criteria=out.success_criteria,
        visuals=[v.id for v in db.list_visuals(sid)],
    )
    flower.stability = stability(prev, flower) if prev else 0.0
    db.put_flower(flower)
    # finding nodes make every finding visible (and traceable) in the graph
    db.ex("DELETE FROM edges WHERE seed_id=? AND dst LIKE 'fnd_%'", (sid,))
    db.ex("DELETE FROM nodes WHERE seed_id=? AND kind='finding'", (sid,))
    for i, f in enumerate(findings):
        db.put_node(ExplorationNode(id=f"fnd_{sid[-8:]}_{i}", seed_id=sid, round=ctx.rnd, kind=NodeKind.finding,
                                    title=f.text[:90], summary=f.text,
                                    parents=[e.ref for e in f.evidence if db.get_node(e.ref)] or [sid],
                                    data={"evidence": [e.model_dump() for e in f.evidence]}))
    seed = db.get_seed(sid) or ctx.seed
    if seed.state in (SeedState.growing, SeedState.dormant):
        seed.state = SeedState.flowering
        db.put_seed(seed)
        ctx.seed = seed
    note = f" ({dropped} finding(s) dropped for missing evidence)" if dropped else ""
    ctx.log(f"Flower v{flower.version} updated — stability {flower.stability:.2f}{note}", {"step": "flower"})


def stability(prev: Flower, cur: Flower) -> float:
    a = {d.node_id or d.title.lower() for d in prev.directions}
    b = {d.node_id or d.title.lower() for d in cur.directions}
    jac = len(a & b) / max(1, len(a | b))
    sim = text.similarity(" ".join(f.text for f in prev.findings), " ".join(f.text for f in cur.findings))
    idea = text.similarity(prev.idea, cur.idea)
    return round(0.4 * jac + 0.4 * sim + 0.2 * idea, 3)


PREPARE: dict[str, Callable[[Ctx], dict[str, Any] | None]] = {
    "ground": prep_ground, "triage": prep_triage, "explore": prep_explore, "check": prep_check,
    "smoke": prep_smoke, "exploit": prep_exploit, "visualize": prep_visualize, "flower": prep_flower,
}
APPLY: dict[str, Callable[[Ctx, Any], None]] = {
    "ground": apply_ground, "triage": apply_triage, "explore": apply_explore, "check": apply_check,
    "smoke": apply_smoke, "exploit": apply_exploit, "visualize": apply_visualize, "flower": apply_flower,
}
CODE: dict[str, Callable[[Ctx], None]] = {"search": do_search, "check_search": do_check_search, "render": do_render}


def tier_of(seed: Seed) -> Tier:
    return seed.tier
