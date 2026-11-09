"""Florist sidecar: FastAPI + WebSocket, serving the React app from ``app/dist``.

Long work (exploration rounds, feed fetches, mining) runs in a thread pool. Progress is written to
the SQLite activity log, and ``/ws`` streams new activity rows to every client — so rounds started
from the CLI, MCP or an external coding agent show up live in the UI too.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from . import __version__, config, deadlines, gateway, paths, profile, providers, research, skills, stats
from .agent import attachments, compost, context, greenhouse, ideate, loop, pack, preferences, scheduler, seedspec, smoke, visuals
from .ingest import feed
from .schemas import FeedSource, LearnedPreference
from .store import db

@asynccontextmanager
async def lifespan(_: FastAPI):
    config.load()
    db.conn()
    feed.ensure_starter_sources()
    # Runs left 'running' by a crashed process are marked failed so the seed can grow again.
    db.ex("UPDATE runs SET status='failed', error='interrupted (process exited)' WHERE status='running'")
    tasks = [asyncio.create_task(hub.poll()), asyncio.create_task(_ticker())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Florist", version=__version__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])
POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="florist")
TICK_SECONDS = 300


def _bg(fn, *args, **kwargs) -> None:
    def run() -> None:
        try:
            fn(*args, **kwargs)
        except Exception as e:  # surfaced through the activity log
            db.log_activity("error", f"{getattr(fn, '__name__', 'job')} failed: {e}")
    POOL.submit(run)


def _seed_or_404(ref: str):
    seed = db.get_seed(ref)
    if not seed:
        raise HTTPException(404, f"no seed {ref}")
    return seed


@app.exception_handler(KeyError)
async def _key_error(_, exc: KeyError) -> JSONResponse:
    return JSONResponse({"detail": str(exc).strip("'\"")}, status_code=404)


@app.exception_handler(ValueError)
async def _value_error(_, exc: ValueError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(gateway.LLMError)
async def _llm_error(_, exc: gateway.LLMError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=502)


# ---------------------------------------------------------------------------
# Status, profile, settings
# ---------------------------------------------------------------------------


@app.get("/api/status")
def status() -> dict[str, Any]:
    counts = {r["state"]: r["n"] for r in db.q("SELECT state, COUNT(*) n FROM seeds GROUP BY state")}
    feed_counts = {r["status"]: r["n"] for r in db.q("SELECT status, COUNT(*) n FROM feed_items GROUP BY status")}
    s = config.get().models
    return {
        "version": __version__, "home": str(paths.home()),
        "models": {role: gateway.check_backend(getattr(s, role)) for role in ("default", "fast", "strong")},
        "seeds": counts, "feed": feed_counts, "compost": len(db.list_compost()),
        "pending_smoke": len(db.list_smoke(status="pending")),
        "usage": gateway.usage_summary()["total"],
    }


@app.get("/api/profile")
def get_profile() -> dict[str, Any]:
    return profile.load().model_dump(mode="json")


@app.put("/api/profile")
def put_profile(patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return profile.update(patch).model_dump(mode="json")


@app.patch("/api/profile/learned/{lp_id}")
def patch_learned(lp_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    prof = profile.load()
    for i, lp in enumerate(prof.learned_preferences):
        if lp.id == lp_id:
            data = {**lp.model_dump(), **patch, "locked": patch.get("locked", True)}
            prof.learned_preferences[i] = LearnedPreference.model_validate(data)
            profile.save(prof)
            return prof.learned_preferences[i].model_dump()
    raise HTTPException(404, "no such learned preference")


@app.delete("/api/profile/learned/{lp_id}")
def delete_learned(lp_id: str) -> dict[str, Any]:
    prof = profile.load()
    prof.learned_preferences = [lp for lp in prof.learned_preferences if lp.id != lp_id]
    profile.save(prof)
    return {"ok": True}


@app.get("/api/profile/raw")
def profile_raw() -> dict[str, str]:
    return {"text": profile.raw_yaml(), "path": str(paths.profile_path())}


@app.put("/api/profile/raw")
def put_profile_raw(body: dict[str, str] = Body(...)) -> dict[str, Any]:
    try:
        return profile.save_raw_yaml(body["text"]).model_dump(mode="json")
    except Exception as e:
        raise HTTPException(400, f"profile.yaml not saved: {str(e)[:400]}")


@app.get("/api/profile/about")
def profile_about() -> dict[str, str]:
    return {"text": profile.load_about(), "path": str(profile.about_path())}


@app.put("/api/profile/about")
def put_profile_about(body: dict[str, str] = Body(...)) -> dict[str, bool]:
    profile.save_about(body["text"])
    return {"ok": True}


DOCS = [("docs/guide.md", "Getting started"), ("docs/agents.md", "Coding agents"),
        ("docs/architecture.md", "How it works"), ("docs/evaluation.md", "Evaluation"),
        ("ASSUMPTIONS.md", "Design decisions")]


@app.get("/api/docs")
def list_docs() -> list[dict[str, str]]:
    return [{"name": n.replace("/", "__"), "title": t} for n, t in DOCS if (paths.RESOURCES / n).exists()]


@app.get("/api/docs/{name}")
def get_doc(name: str) -> dict[str, str]:
    rel = name.replace("__", "/")
    if rel not in {n for n, _ in DOCS}:
        raise HTTPException(404)
    return {"text": (paths.RESOURCES / rel).read_text(encoding="utf-8")}


@app.get("/api/share")
def share(url: str, note: str = "") -> Response:
    """Target for the 'Save to Florist' bookmarklet / share sheet."""
    _bg(feed.add_link, url, note)
    return Response("saved to Florist", media_type="text/plain")


@app.post("/api/profile/learn")
def learn() -> dict[str, Any]:
    learned = preferences.distill()
    return {"learned": [lp.model_dump() for lp in learned], "events": preferences.event_summary(20)["counts"]}


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return config.redacted()


@app.put("/api/settings")
def put_settings(patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    patch.pop("keys", None)
    patch.pop("keys_present", None)
    config.update(patch)
    return config.redacted()


@app.post("/api/settings/keys")
def set_key(body: dict[str, str] = Body(...)) -> dict[str, Any]:
    s = config.get()
    keys = dict(s.keys)
    if body.get("key"):
        keys[body["provider"]] = body["key"]
    else:
        keys.pop(body["provider"], None)
    config.update({"keys": keys})
    return config.redacted()


@app.get("/api/models/check")
def models_check(model: str | None = None) -> dict[str, Any]:
    return gateway.check_backend(model)


@app.get("/api/usage")
def usage(seed: str | None = None) -> dict[str, Any]:
    out = gateway.usage_summary(seed)
    out["recent"] = [dict(r) for r in db.q(
        "SELECT created, step, seed_id, backend, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error "
        "FROM llm_calls ORDER BY id DESC LIMIT 60")]
    return out


@app.get("/api/activity")
def activity(seed: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    return db.recent_activity(seed, limit)


@app.get("/api/deadlines")
def get_deadlines(all: bool = False) -> list[dict[str, Any]]:
    try:
        return deadlines.upcoming() if all else deadlines.for_profile()
    except Exception as e:
        raise HTTPException(502, f"AI Deadlines unavailable: {e}")


@app.get("/api/skills")
def list_skills() -> list[dict[str, Any]]:
    return [{"name": s.name, "description": s.description, "agent": s.agent_facing} for s in skills.all_skills()]


@app.get("/api/skills/{name}")
def get_skill(name: str) -> dict[str, str]:
    try:
        s = skills.get(name)
    except KeyError:
        raise HTTPException(404, f"no skill {name}")
    return {"name": s.name, "text": s.body}


@app.post("/api/tick")
def tick() -> dict[str, str]:
    _bg(scheduler.tick)
    return {"status": "started"}


# ---------------------------------------------------------------------------
# Seeds, loop, graph, flower
# ---------------------------------------------------------------------------


def _seed_summary(seed) -> dict[str, Any]:
    flower = db.latest_flower(seed.id)
    run = loop.active_run(seed.id)
    return {**seed.model_dump(mode="json"),
            "flower": {"version": flower.version, "stability": flower.stability, "idea": flower.idea[:300],
                       "directions": [d.title for d in flower.directions]} if flower else None,
            "run": {"id": run["id"], "status": run["status"], "step": run["step"], "round": run["round"],
                    "mode": run["mode"]} if run else None,
            "usd": round(gateway.spent(seed_id=seed.id), 4),
            "stage": greenhouse.stage(seed),
            "counts": {r["kind"]: r["n"] for r in db.q("SELECT kind, COUNT(*) n FROM nodes WHERE seed_id=? GROUP BY kind",
                                                        (seed.id,))},
            "pending_smoke": len([s for s in db.list_smoke(seed.id) if s.status == "pending"])}


@app.get("/api/seeds")
def list_seeds(all: bool = False, state: str | None = None) -> list[dict[str, Any]]:
    return [_seed_summary(s) for s in db.list_seeds(state=state, include_candidates=all)]


@app.post("/api/seeds")
def create_seed(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    seed, questions = greenhouse.create_seed(
        body["prompt"], tier=body.get("tier", "personal"), title=body.get("title", ""),
        technologies=body.get("technologies") or [], constraints=body.get("constraints") or {},
        priority=int(body.get("priority", 3)), compost_ids=body.get("compost_ids") or [],
        related_papers=body.get("related_papers") or [], ask_followups=bool(body.get("ask_followups", True)),
        passive=bool(body.get("passive", False)),
    )
    return {"seed": seed.model_dump(mode="json"), "questions": questions}


@app.get("/api/seeds/{ref}")
def get_seed(ref: str) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    return {**_seed_summary(seed), "runs": loop.list_runs(seed.id, 5)}


@app.patch("/api/seeds/{ref}")
def patch_seed(ref: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return greenhouse.update_seed(ref, patch).model_dump(mode="json")


@app.delete("/api/seeds/{ref}")
def delete_seed(ref: str) -> dict[str, Any]:
    db.delete_seed(_seed_or_404(ref).id)
    return {"ok": True}


@app.post("/api/seeds/{ref}/state")
def seed_state(ref: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return greenhouse.set_state(ref, body["state"]).model_dump(mode="json")


@app.post("/api/seeds/{ref}/followups")
def followups(ref: str, body: dict[str, list[str]] = Body(...)) -> dict[str, Any]:
    return greenhouse.answer_followups(ref, body["answers"]).model_dump(mode="json")


@app.post("/api/seeds/{ref}/compost")
def seed_to_compost(ref: str, body: dict[str, str] = Body(default={})) -> dict[str, Any]:
    return greenhouse.compost_seed(ref, body.get("reason") or "moved to compost by you").model_dump()


@app.post("/api/seeds/{ref}/grow")
def grow(ref: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    if loop.active_run(seed.id) and loop.active_run(seed.id)["status"] == "running":
        raise HTTPException(409, "this seed is already growing")
    ctx = loop.start(seed.id, int(body.get("rounds", 1)), body.get("mode", "live"))
    _bg(loop.drive, ctx, body.get("model") or None)
    return {"run_id": ctx.run_id, "status": "running"}


@app.post("/api/seeds/{ref}/stop")
def stop(ref: str) -> dict[str, Any]:
    return {"stopped": loop.request_stop(_seed_or_404(ref).id)}


@app.get("/api/seeds/{ref}/runs")
def runs(ref: str) -> list[dict[str, Any]]:
    return loop.list_runs(_seed_or_404(ref).id)


@app.post("/api/seeds/{ref}/round/start")
def round_start(ref: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    ctx = loop.start(ref, int(body.get("rounds", 1)), "agent")
    return loop.next_task(run_id=ctx.run_id)


@app.get("/api/seeds/{ref}/round/next")
def round_next(ref: str) -> dict[str, Any]:
    return loop.next_task(ref)


@app.post("/api/seeds/{ref}/round/submit")
def round_submit(ref: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return loop.submit(ref, body)


@app.get("/api/seeds/{ref}/graph")
def graph(ref: str) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    return {"nodes": [n.model_dump(mode="json") for n in db.list_nodes(seed.id)], "edges": db.list_edges(seed.id),
            "mermaid": visuals.graph_mermaid(seed.id)}


@app.get("/api/seeds/{ref}/flower")
def flower(ref: str, version: int | None = None) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    hist = db.flower_history(seed.id)
    cur = next((f for f in hist if f.version == version), None) if version else (hist[-1] if hist else None)
    refs: dict[str, Any] = {}
    if cur:
        ids = {e.ref for f in cur.findings for e in f.evidence} | {c.ref for c in cur.novelty.closest_work}
        for i in ids:
            n = db.get_node(i)
            if n:
                refs[i] = {"title": n.title, "url": n.url, "kind": n.kind.value, "year": n.data.get("year"),
                           "summary": n.summary}
            else:
                s = db.get_smoke(i)
                if s:
                    refs[i] = {"title": f"Smoke: {s.assumption}", "kind": "smoke", "summary": s.verdict}
    return {"flower": cur.model_dump(mode="json") if cur else None, "refs": refs,
            "versions": [{"version": f.version, "round": f.round, "stability": f.stability, "updated": f.updated}
                         for f in hist]}


@app.get("/api/seeds/{ref}/visuals")
def seed_visuals(ref: str) -> list[dict[str, Any]]:
    return [v.model_dump() for v in db.list_visuals(_seed_or_404(ref).id)]


@app.get("/api/visuals/{seed_id}/{name}")
def visual_file(seed_id: str, name: str) -> Response:
    base = visuals.seed_dir(seed_id).resolve()
    f = (base / name).resolve()
    if base not in f.parents or not f.exists():
        raise HTTPException(404)
    mt = "image/svg+xml" if f.suffix == ".svg" else (mimetypes.guess_type(f.name)[0] or "text/plain")
    return FileResponse(f, media_type=mt, headers={"Cache-Control": "no-cache"})


@app.post("/api/nodes/{node_id}/action")
def node_action(node_id: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return greenhouse.direction_action(node_id, body["action"], body.get("note", ""))


@app.get("/api/seeds/{ref}/smoke")
def seed_smoke(ref: str) -> list[dict[str, Any]]:
    return [s.model_dump() for s in db.list_smoke(_seed_or_404(ref).id)]


@app.get("/api/smoke")
def all_smoke(status: str | None = None) -> list[dict[str, Any]]:
    return [s.model_dump() for s in db.list_smoke(status=status)]


@app.post("/api/smoke/{smoke_id}/approve")
def approve_smoke(smoke_id: str) -> dict[str, str]:
    _bg(smoke.run, smoke_id, True)
    return {"status": "running"}


@app.post("/api/smoke/{smoke_id}/reject")
def reject_smoke(smoke_id: str) -> dict[str, Any]:
    return smoke.reject(smoke_id).model_dump()


@app.get("/api/seeds/{ref}/chat")
def get_chat(ref: str) -> list[dict[str, Any]]:
    return greenhouse.chat_history(_seed_or_404(ref).id)


@app.post("/api/seeds/{ref}/chat")
def post_chat(ref: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    res = greenhouse.chat(seed.id, body["message"], body.get("model") or None, body.get("skills") or [],
                          body.get("context") or [], body.get("effort"))
    if any(a["type"] == "run_round" and a.get("ok") for a in res["actions"]) and not loop.active_run(seed.id):
        ctx = loop.start(seed.id, 1, "live")
        _bg(loop.drive, ctx)
        res["started_run"] = ctx.run_id
    return res


@app.post("/api/seeds/{ref}/steer")
def post_steer(ref: str, body: dict[str, str] = Body(...)) -> dict[str, bool]:
    greenhouse.steer(_seed_or_404(ref).id, body["note"])
    return {"ok": True}


@app.post("/api/seeds/{ref}/idea")
def post_idea(ref: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return greenhouse.inject_idea(_seed_or_404(ref).id, body["idea"])


@app.get("/api/adapters")
def adapters() -> list[dict[str, Any]]:
    return pack.list_adapters()


@app.post("/api/seeds/{ref}/pick")
def pick(ref: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    dest = pack.pick(ref, body.get("out_dir") or None, body.get("adapters") or None)
    return {"path": str(dest), "files": sorted(str(p.relative_to(dest)).replace("\\", "/")
                                                for p in dest.rglob("*") if p.is_file())}


@app.get("/api/packs")
def packs() -> list[dict[str, Any]]:
    return [dict(r) for r in db.q("SELECT * FROM packs ORDER BY created DESC")]


@app.get("/api/packs/file")
def pack_file(path: str, name: str) -> Response:
    rows = {Path(r["path"]).resolve() for r in db.q("SELECT path FROM packs")}
    base = Path(path).resolve()
    f = (base / name).resolve()
    if base not in rows or base not in f.parents or not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/svg+xml" if f.suffix == ".svg" else "text/plain; charset=utf-8")


# ---------------------------------------------------------------------------
# Feed, sources, compost
# ---------------------------------------------------------------------------


@app.get("/api/feed")
def get_feed(status: str = Query("kept"), limit: int = 200, sort: str = "", viewed: bool = False) -> list[dict[str, Any]]:
    statuses = status.split(",") if status != "all" else None
    return [i.model_dump(mode="json") for i in db.list_feed(statuses, limit, sort, viewed)]


@app.post("/api/feed/fetch")
def fetch_feed(body: dict[str, Any] = Body(default={})) -> dict[str, str]:
    _bg(feed.fetch, body.get("source_id"), bool(body.get("force", True)))
    return {"status": "started"}


@app.post("/api/feed/link")
def feed_link(body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return feed.add_link(body["url"], body.get("note", "")).model_dump(mode="json")


@app.post("/api/feed/{item_id}/action")
def feed_action(item_id: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return feed.act(item_id, body["action"], body.get("seed_id", ""), body.get("note", ""), body.get("tier", "exploration"))


@app.get("/api/sources")
def get_sources() -> list[dict[str, Any]]:
    feed.ensure_starter_sources()
    return [s.model_dump() for s in db.list_sources()]


@app.post("/api/sources")
def add_source(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    body.setdefault("id", db.new_id("src"))
    return db.put_source(FeedSource.model_validate(body)).model_dump()


@app.delete("/api/sources/{source_id}")
def delete_source(source_id: str) -> dict[str, bool]:
    db.delete_source(source_id)
    return {"ok": True}


@app.get("/api/compost")
def get_compost() -> list[dict[str, Any]]:
    return [c.model_dump() for c in db.list_compost()]


@app.post("/api/compost")
def add_compost(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return compost.add(body.get("title", ""), body.get("link", ""), body.get("note", ""),
                       body.get("tags") or []).model_dump()


@app.patch("/api/compost/{item_id}")
def patch_compost(item_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return compost.update(item_id, patch).model_dump()


@app.delete("/api/compost/{item_id}")
def delete_compost(item_id: str) -> dict[str, bool]:
    db.delete_compost(item_id)
    return {"ok": True}


@app.get("/api/compost/clusters")
def compost_clusters(refresh: bool = False) -> list[dict[str, Any]]:
    return compost.clusters() if refresh or not compost.cached_clusters() else compost.cached_clusters()


@app.post("/api/compost/mine")
def mine() -> dict[str, Any]:
    return {"candidates": [s.model_dump(mode="json") for s in compost.mine()]}


@app.post("/api/compost/seed")
def compost_seed(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return compost.seed_from(body["ids"], body.get("prompt", ""), body.get("tier", "exploration"),
                             body.get("title", "")).model_dump(mode="json")


@app.post("/api/candidates/{ref}/{decision}")
def candidate(ref: str, decision: str) -> dict[str, Any]:
    if decision == "accept":
        return compost.accept_candidate(ref).model_dump(mode="json")
    compost.reject_candidate(ref)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Seed spec sheet, stats, files, context
# ---------------------------------------------------------------------------


@app.get("/api/seeds/{ref}/spec")
def get_spec(ref: str) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    return {"text": seedspec.read(seed), "path": str(seedspec.path(seed))}


@app.put("/api/seeds/{ref}/spec")
def put_spec(ref: str, body: dict[str, str] = Body(...)) -> dict[str, bool]:
    seed = _seed_or_404(ref)
    seedspec.write(seed, body["text"])
    db.log_activity("seed", "Spec sheet updated", seed.id)
    return {"ok": True}


@app.get("/api/seeds/{ref}/stats")
def seed_stats(ref: str) -> dict[str, Any]:
    return stats.seed_stats(_seed_or_404(ref).id)


@app.get("/api/seeds/{ref}/files")
def seed_files(ref: str) -> dict[str, Any]:
    seed = _seed_or_404(ref)
    srcs = sorted([n for n in db.list_nodes(seed.id, "source") if n.status.value != "pruned"],
                  key=lambda n: -(n.score or 0))
    packs = [dict(r) for r in db.q("SELECT * FROM packs WHERE seed_id=? ORDER BY created DESC", (seed.id,))]
    return {
        "papers": [{"id": n.id, "title": n.title, "url": n.url, "kind": n.data.get("kind", "paper"),
                    "tool": n.data.get("tool", ""), "year": n.data.get("year"), "pdf": research_pdf_url(n.url)}
                   for n in srcs if n.data.get("kind") in ("paper", "web", "compost")][:40],
        "repos": [{"id": n.id, "title": n.title, "url": n.url, "stars": n.data.get("stars")}
                  for n in srcs if n.data.get("kind") == "repo"][:20],
        "experiments": [{"id": s.id, "assumption": s.assumption, "status": s.status, "verdict": s.verdict}
                        for s in db.list_smoke(seed.id)],
        "artifacts": [{"id": v.id, "title": v.title, "kind": v.kind, "files": v.files} for v in db.list_visuals(seed.id)],
        "packs": packs,
        "context": context.resolve([{"kind": "compost", "id": i} for i in seed.compost_ids]
                                   + [{"kind": "feed", "id": i} for i in seed.feed_ids]
                                   + [{"kind": "file", "id": i} for i in seed.attachment_ids]),
    }


@app.post("/api/seeds/{ref}/context")
def seed_add_context(ref: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return greenhouse.attach_context(_seed_or_404(ref).id, body).model_dump(mode="json")


@app.delete("/api/seeds/{ref}/context/{kind}/{item_id}")
def seed_remove_context(ref: str, kind: str, item_id: str) -> dict[str, Any]:
    return greenhouse.detach_context(_seed_or_404(ref).id, kind, item_id).model_dump(mode="json")


# ---------------------------------------------------------------------------
# Ideate chats
# ---------------------------------------------------------------------------


@app.get("/api/ideate")
def ideate_list() -> list[dict[str, Any]]:
    return ideate.list_chats()


@app.post("/api/ideate")
def ideate_create(body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    return ideate.create(body.get("title", ""), body.get("context") or [])


@app.get("/api/ideate/{chat_id}")
def ideate_get(chat_id: str) -> dict[str, Any]:
    return ideate.get(chat_id)


@app.patch("/api/ideate/{chat_id}")
def ideate_rename(chat_id: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return ideate.rename(chat_id, body["title"])


@app.delete("/api/ideate/{chat_id}")
def ideate_delete(chat_id: str) -> dict[str, bool]:
    ideate.delete(chat_id)
    return {"ok": True}


@app.post("/api/ideate/{chat_id}/message")
def ideate_message(chat_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    res = ideate.message(chat_id, body["message"], body.get("skills") or [], body.get("model") or None,
                         body.get("effort"), body.get("tier", ""))
    if res.get("seed_id"):
        ctx = loop.start(res["seed_id"], 1, "live")
        _bg(loop.drive, ctx)
    return res


@app.post("/api/ideate/{chat_id}/context")
def ideate_add_context(chat_id: str, body: dict[str, str] = Body(...)) -> dict[str, Any]:
    return ideate.add_context(chat_id, body)


@app.delete("/api/ideate/{chat_id}/context/{kind}/{item_id}")
def ideate_remove_context(chat_id: str, kind: str, item_id: str) -> dict[str, Any]:
    return ideate.remove_context(chat_id, kind, item_id)


@app.post("/api/ideate/{chat_id}/seed")
def ideate_to_seed(chat_id: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    return ideate.to_seed(chat_id, body.get("tier", ""), body.get("model") or None)


@app.post("/api/feed/lucky")
def feed_lucky() -> dict[str, Any]:
    return ideate.feeling_lucky()


@app.get("/api/compost/search")
def compost_search(q: str = "", limit: int = 12) -> list[dict[str, Any]]:
    return context.search_compost(q, limit)


@app.get("/api/composer/skills")
def composer_skills() -> list[dict[str, str]]:
    return [{"id": k, **v} for k, v in context.COMPOSER_SKILLS.items()]


@app.post("/api/attachments")
def add_attachment(body: dict[str, str] = Body(...)) -> dict[str, Any]:
    a = attachments.add(body["name"], body["data"], body.get("mime", ""))
    return {"id": a.id, "name": a.name, "chars": len(a.text)}


# ---------------------------------------------------------------------------
# Profile document, providers, statistics, reader
# ---------------------------------------------------------------------------


@app.get("/api/profile/doc")
def profile_doc() -> dict[str, Any]:
    text = profile.load_doc()
    return {"text": text, "path": str(profile.doc_path()), "outline": profile.outline(text),
            "begin": profile.BEGIN, "end": profile.END}


@app.put("/api/profile/doc")
def put_profile_doc(body: dict[str, str] = Body(...)) -> dict[str, Any]:
    prof = profile.save_doc(body["text"])
    _bg(profile.sync_with_model)
    return prof.model_dump(mode="json")


@app.get("/api/providers")
def get_providers() -> list[dict[str, Any]]:
    return providers.status()


@app.get("/api/models/configured")
def configured_models() -> list[str]:
    return providers.configured_models()


@app.get("/api/models/catalog")
def models_catalog() -> list[dict[str, Any]]:
    return providers.catalog()


@app.get("/api/stats")
def get_stats(days: int = 60) -> dict[str, Any]:
    return stats.global_stats(days)


def research_pdf_url(url: str) -> str:
    """Best-effort PDF link for a paper URL (arXiv, alphaXiv, Hugging Face papers, direct .pdf)."""
    if not url:
        return ""
    if url.lower().split("?")[0].endswith(".pdf"):
        return url
    aid = research.arxiv_id(url)
    if aid and any(h in url for h in ("arxiv.org", "alphaxiv.org", "huggingface.co/papers")):
        return f"https://arxiv.org/pdf/{aid}"
    return ""


@app.get("/api/reader")
def reader(url: str) -> Response:
    """Fetch a paper PDF (cached) and serve it same-origin so the in-app reader can embed it."""
    import hashlib

    import httpx

    pdf = research_pdf_url(url)
    if not pdf:
        raise HTTPException(415, "no PDF available for this link")
    cache = paths.sub("cache", "pdf") / (hashlib.sha256(pdf.encode()).hexdigest()[:24] + ".pdf")
    if not cache.exists():
        try:
            with httpx.Client(timeout=40, follow_redirects=True, headers={"User-Agent": research.UA}) as c:
                r = c.get(pdf)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"could not fetch the PDF: {e}")
        if r.status_code >= 400 or not r.content.startswith(b"%PDF"):
            raise HTTPException(415, "the link did not return a PDF")
        cache.write_bytes(r.content)
    return FileResponse(cache, media_type="application/pdf", headers={"Content-Disposition": "inline"})


# ---------------------------------------------------------------------------
# Live events
# ---------------------------------------------------------------------------


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.last_id = 0

    async def poll(self) -> None:
        row = db.q1("SELECT COALESCE(MAX(id),0) m FROM activity")
        self.last_id = int(row["m"]) if row else 0
        while True:
            await asyncio.sleep(0.8)
            try:
                rows = db.activity_since(self.last_id)
            except Exception:
                continue
            if not rows:
                continue
            self.last_id = rows[-1]["id"]
            dead = []
            for ws in list(self.clients):
                try:
                    await ws.send_text(json.dumps({"type": "activity", "items": rows}))
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)


hub = Hub()


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    hub.clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.clients.discard(websocket)


async def _ticker() -> None:
    while True:
        await asyncio.sleep(TICK_SECONDS)
        await asyncio.get_running_loop().run_in_executor(POOL, _safe_tick)


def _safe_tick() -> None:
    try:
        scheduler.tick()
    except Exception as e:
        db.log_activity("error", f"scheduler tick failed: {e}")


# ---------------------------------------------------------------------------
# Static UI
# ---------------------------------------------------------------------------


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str) -> Response:
    dist = paths.ui_dist()
    if full_path.startswith("api/"):
        raise HTTPException(404)
    f = (dist / full_path).resolve()
    if full_path and f.is_file() and dist.resolve() in f.parents:
        return FileResponse(f)
    index = dist / "index.html"
    if index.exists():
        return FileResponse(index)
    return Response("<h1>Florist</h1><p>The UI is not built. Run <code>cd app && pnpm install && pnpm build</code>, "
                    "or use the CLI: <code>florist --help</code>.</p>", media_type="text/html")
