"""Feed views and new source kinds, composer skills, attachments."""

import base64

import pytest
from fastapi.testclient import TestClient

from florist import research as research_mod
from florist import server
from florist.agent import composer, context, greenhouse, ideate
from florist.ingest import feed, sources
from florist.schemas import FeedItem, FeedSource
from florist.server import app
from florist.store import db


def _feed(id_, published, **kw):
    item = FeedItem(id=id_, title=id_, url=f"https://ex.org/{id_}", published=published, status="kept", **kw)
    db.insert_feed_item(item)
    return item


def test_feed_sorts_newest_first_and_tracks_viewed():
    _feed("fd_old", "2026-01-01", score=0.9)
    _feed("fd_new", "2026-11-01", score=0.1)
    assert [i.id for i in db.list_feed(["kept"], 10)] == ["fd_old", "fd_new"]
    assert [i.id for i in db.list_feed(["kept"], 10, sort="recent")] == ["fd_new", "fd_old"]
    assert db.list_feed(["kept"], 10, viewed=True) == []
    feed.act("fd_old", "view")
    assert [i.id for i in db.list_feed(["kept"], 10, viewed=True)] == ["fd_old"]
    with TestClient(app) as c:
        rows = c.get("/api/feed?status=kept&sort=recent&viewed=true").json()
    assert [r["id"] for r in rows] == ["fd_old"] and rows[0]["viewed_at"]


def test_new_starter_sources_are_off_and_offered_once():
    db.put_source(sources.STARTER_SOURCES[0])  # an install from before these defaults existed
    feed.ensure_starter_sources()
    by_id = {s.id: s for s in db.list_sources()}
    assert "src_hn_llm" not in by_id, "originals the user removed stay removed"
    assert not by_id["src_arxiv_csro"].enabled and not by_id["src_hf_models_hot"].enabled
    db.delete_source("src_arxiv_csro")
    feed.ensure_starter_sources()
    assert "src_arxiv_csro" not in {s.id for s in db.list_sources()}


def test_fresh_install_gets_every_starter():
    feed.ensure_starter_sources()
    assert {s.id for s in db.list_sources()} == {s.id for s in sources.STARTER_SOURCES}


def test_hf_hub_popular_and_new(monkeypatch):
    seen = {}

    class R:
        def json(self):
            return [{"id": "org/robot", "likes": 5, "downloads": 9, "pipeline_tag": "robotics",
                     "tags": ["lerobot", "license:mit"], "createdAt": "2026-01-02T00:00:00Z"}]

    monkeypatch.setattr(sources, "_fetch", lambda url, **p: seen.update(url=url, **p) or R())
    new = sources.fetch_hf_hub(FeedSource(id="s", kind="hf_hub", name="n", config={"mode": "new", "repo_type": "datasets"}))
    assert seen["sort"] == "createdAt" and seen["url"].endswith("/api/datasets")
    assert new[0].url == "https://huggingface.co/datasets/org/robot" and new[0].published == "2026-01-02"
    assert new[0].tags == ["lerobot"]
    hot = sources.fetch_hf_hub(FeedSource(id="s", kind="hf_hub", name="n", config={"query": "robotics"}))
    assert seen["sort"] == "trendingScore" and seen["search"] == "robotics"
    assert hot[0].url == "https://huggingface.co/org/robot" and hot[0].published != "2026-01-02"


def test_github_modes(monkeypatch):
    calls = []
    monkeypatch.setattr(research_mod, "github", lambda q, limit=6, since=None: calls.append((q, since)) or [])
    sources.fetch_github(FeedSource(id="s", kind="github", name="n", config={"mode": "popular", "topic": "robotics"}))
    sources.fetch_github(FeedSource(id="s", kind="github", name="n", config={"topic": "robotics"}))
    assert "stars:>=" in calls[0][0] and calls[0][1]
    assert "created:>=" in calls[1][0]


def test_twitter_explains_what_it_needs():
    with pytest.raises(RuntimeError, match="bearer token"):
        sources.fetch_twitter(FeedSource(id="s", kind="twitter", name="n", config={"handle": "someone"}))


def test_conference_keeps_accepted_and_skips_submitted(monkeypatch):
    atom = b"""<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry><id>a</id><title>Accepted one</title><link href="https://arxiv.org/abs/a"/>
        <published>2026-10-01T00:00:00Z</published><summary>s</summary><arxiv:comment>Accepted to CoRL 2026</arxiv:comment></entry>
      <entry><id>b</id><title>Submitted one</title><link href="https://arxiv.org/abs/b"/>
        <published>2026-10-02T00:00:00Z</published><summary>s</summary><arxiv:comment>Submitted to CoRL 2026</arxiv:comment></entry>
    </feed>"""

    class R:
        content = atom

        def json(self):
            return {"results": []}

    monkeypatch.setattr(sources, "_fetch", lambda url, **p: R())
    items = sources.fetch_conference(FeedSource(id="s", kind="conference", name="n", config={"venue": "CoRL"}))
    assert [i.title for i in items] == ["Accepted one"]


def test_each_composer_skill_replies_in_ideate(monkeypatch):
    monkeypatch.setattr(sources, "FETCHERS", {k: (lambda s: [1]) for k in sources.FETCHERS})
    for i in range(4):
        _feed(f"fd_{i}", "2026-11-01", summary="tiny robot arm")
    for skill in set(context.COMPOSER_SKILLS) - {composer.LOOP_SKILL}:
        chat = ideate.create()
        res = ideate.message(chat["id"], "robot arm grasping", [skill])
        assert res["reply"], skill
        msgs = ideate.get(chat["id"])["messages"]
        assert msgs[0]["actions"] == [{"type": "skills", "skills": [skill]}] and msgs[1]["content"] == res["reply"]


def test_skill_without_text_shows_its_label_and_uses_the_conversation(monkeypatch):
    asked = []
    original = research_mod.search
    monkeypatch.setattr(research_mod, "search", lambda q, **k: asked.append(q) or original(q, **k))
    chat = ideate.create()
    ideate.message(chat["id"], "tactile sensing for cheap grippers")
    ideate.message(chat["id"], "", ["novelty"])
    msgs = ideate.get(chat["id"])["messages"]
    assert msgs[2]["content"] == "Check novelty"
    assert "tactile" in asked[0].lower() and "check novelty" not in asked[0].lower()


def test_feed_ideas_become_candidates():
    _feed("fd_a", "2026-11-01", summary="soft grippers")
    out = composer.run("feed_ideas", composer.Scope(message=""))
    cands = [s for s in db.list_seeds(include_candidates=True) if s.state.value == "candidate"]
    assert cands and cands[0].feed_ids == ["fd_a"] and "Greenhouse" in out["reply"]


def test_found_sources_are_probed(monkeypatch):
    monkeypatch.setattr(sources, "FETCHERS", {**sources.FETCHERS, "arxiv": lambda s: []})
    out = composer.run("find_sources", composer.Scope(message="robots"))
    cards = out["actions"][0]["sources"]
    assert cards and all(c["kind"] == "arxiv" and c["ok"] is False and "category" in c["config"] for c in cards)


def test_deep_research_from_ideate_plants_a_seed_and_starts_the_loop(monkeypatch):
    started = []
    monkeypatch.setattr(server.loop, "start", lambda sid, rounds, mode: started.append(sid) or "ctx")
    monkeypatch.setattr(server, "_bg", lambda fn, *a: None)
    with TestClient(app) as c:
        chat = c.post("/api/ideate", json={}).json()
        res = c.post(f"/api/ideate/{chat['id']}/message",
                     json={"message": "robot hands", "skills": ["deep_research"], "tier": "formal"}).json()
    seed = db.get_seed(res["seed_id"])
    assert started == [seed.id] and seed.tier.value == "formal"


def test_deep_research_in_a_seed_starts_a_round(monkeypatch):
    seed, _ = greenhouse.create_seed("Robot hands that feel", tier="personal")
    started = []
    monkeypatch.setattr(server.loop, "start", lambda sid, rounds, mode: started.append(sid) or type("C", (), {"run_id": "r"})())
    monkeypatch.setattr(server.loop, "active_run", lambda sid: None)
    monkeypatch.setattr(server, "_bg", lambda fn, *a: None)
    with TestClient(app) as c:
        res = c.post(f"/api/seeds/{seed.id}/chat", json={"message": "focus on tactile", "skills": ["deep_research"]}).json()
    assert started == [seed.id] and res["started_run"] == "r"


def test_attachment_flows_into_ideate_and_its_seed():
    with TestClient(app) as c:
        data = base64.b64encode(b"# Notes\nTactile sensors are cheap now.").decode()
        att = c.post("/api/attachments", json={"name": "../notes.md", "data": data}).json()
        assert att["name"] == "notes.md"
        chat = c.post("/api/ideate", json={}).json()
        c.post(f"/api/ideate/{chat['id']}/context", json={"kind": "file", "id": att["id"]})
        got = c.get(f"/api/ideate/{chat['id']}").json()
    assert got["context"][0]["title"] == "notes.md"
    assert "Tactile" in context.resolve(got["context"])[0]["text"]
    ideate.message(chat["id"], "what now?")
    assert ideate.to_seed(chat["id"])["seed"]["attachment_ids"] == [att["id"]]


def test_binary_attachment_is_refused():
    with TestClient(app) as c:
        r = c.post("/api/attachments", json={"name": "a.png", "data": base64.b64encode(b"\x89PNG\0\0\0").decode()})
    assert r.status_code == 400 and "a.png" in r.json()["detail"]


def test_new_seed_from_feed_uses_the_chosen_tier():
    _feed("fd_tier", "2026-11-01")
    res = feed.act("fd_tier", "seed", tier="formal")
    assert db.get_seed(res["seed_id"]).tier.value == "formal"
