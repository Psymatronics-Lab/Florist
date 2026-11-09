"""SQLite access: migrations, a thread-local connection, and typed document helpers.

Every record table stores a validated JSON ``doc`` plus a few indexed columns.
Writers go through ``put_*`` helpers so indexed columns never drift from the doc.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, TypeVar

from pydantic import BaseModel

from .. import paths
from ..schemas import (
    Attachment,
    CompostItem,
    ExplorationNode,
    FeedItem,
    FeedSource,
    Flower,
    Seed,
    SmokeCheck,
    Visual,
    now_iso,
)

T = TypeVar("T", bound=BaseModel)
_local = threading.local()
_migrated: set[str] = set()
_lock = threading.Lock()


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def slugify(text: str, max_len: int = 48) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s[:max_len].rstrip("-")) or "seed"


def conn() -> sqlite3.Connection:
    path = str(paths.db_path())
    c: sqlite3.Connection | None = getattr(_local, "conn", None)
    if c is None or getattr(_local, "path", None) != path:
        c = sqlite3.connect(path, timeout=30, check_same_thread=False, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=30000")
        _local.conn, _local.path = c, path
    if path not in _migrated:
        with _lock:
            if path not in _migrated:
                migrate(c)
                _migrated.add(path)
    return c


def reset_connection() -> None:
    """Forget the cached connection (tests switch FLORIST_HOME between cases)."""
    c = getattr(_local, "conn", None)
    if c is not None:
        c.close()
    _local.conn = None
    _migrated.clear()


def migrate(c: sqlite3.Connection) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied TEXT NOT NULL)")
    done = {r[0] for r in c.execute("SELECT name FROM schema_migrations")}
    for f in sorted(Path(paths.migrations_dir()).glob("*.sql")):
        if f.name in done:
            continue
        c.executescript(f.read_text(encoding="utf-8"))
        c.execute("INSERT INTO schema_migrations VALUES (?, ?)", (f.name, now_iso()))


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    c = conn()
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise


def q(sql: str, params: tuple | list = ()) -> list[sqlite3.Row]:
    return conn().execute(sql, params).fetchall()


def q1(sql: str, params: tuple | list = ()) -> sqlite3.Row | None:
    return conn().execute(sql, params).fetchone()


def ex(sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
    return conn().execute(sql, params)


def _doc(m: BaseModel) -> str:
    return m.model_dump_json()


def _load(model: type[T], row: sqlite3.Row | None) -> T | None:
    return model.model_validate_json(row["doc"]) if row else None


def _loads(model: type[T], rows: list[sqlite3.Row]) -> list[T]:
    return [model.model_validate_json(r["doc"]) for r in rows]


# ---------------------------------------------------------------------------
# Seeds
# ---------------------------------------------------------------------------


def put_seed(s: Seed) -> Seed:
    s.updated = now_iso()
    ex(
        """INSERT INTO seeds(id, slug, state, tier, priority, passive, updated, doc) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, state=excluded.state, tier=excluded.tier,
             priority=excluded.priority, passive=excluded.passive, updated=excluded.updated, doc=excluded.doc""",
        (s.id, s.slug, s.state.value, s.tier.value, s.priority, int(s.passive), s.updated, _doc(s)),
    )
    return s


def unique_slug(title: str, seed_id: str | None = None) -> str:
    base = slugify(title)
    slug, n = base, 2
    while True:
        row = q1("SELECT id FROM seeds WHERE slug=?", (slug,))
        if not row or row["id"] == seed_id:
            return slug
        slug, n = f"{base}-{n}", n + 1


def get_seed(ref: str) -> Seed | None:
    row = q1("SELECT doc FROM seeds WHERE id=? OR slug=?", (ref, ref))
    if row:
        return _load(Seed, row)
    rows = q("SELECT doc FROM seeds WHERE id LIKE ? OR slug LIKE ?", (f"{ref}%", f"{ref}%"))
    return _load(Seed, rows[0]) if len(rows) == 1 else None


def list_seeds(state: str | None = None, include_candidates: bool = False) -> list[Seed]:
    if state:
        rows = q("SELECT doc FROM seeds WHERE state=? ORDER BY priority DESC, updated DESC", (state,))
    elif include_candidates:
        rows = q("SELECT doc FROM seeds ORDER BY priority DESC, updated DESC")
    else:
        rows = q(
            "SELECT doc FROM seeds WHERE state NOT IN ('candidate','composted') ORDER BY priority DESC, updated DESC"
        )
    return _loads(Seed, rows)


def delete_seed(seed_id: str) -> None:
    with tx() as c:
        for t in ("nodes", "edges", "flowers", "smoke", "visuals", "runs", "chat", "packs"):
            c.execute(f"DELETE FROM {t} WHERE seed_id=?", (seed_id,))
        c.execute("DELETE FROM seeds WHERE id=?", (seed_id,))


# ---------------------------------------------------------------------------
# Feed
# ---------------------------------------------------------------------------


def feed_dedupe_key(item: FeedItem) -> str:
    return item.url or f"{item.source_kind}:{item.external_id or item.title}"


def insert_feed_item(item: FeedItem) -> bool:
    """Insert if new. Returns False when the item was already seen."""
    cur = ex(
        "INSERT OR IGNORE INTO feed_items(id, dedupe_key, source_id, status, score, created, doc) VALUES (?,?,?,?,?,?,?)",
        (item.id, feed_dedupe_key(item), item.source_id, item.status.value, item.score, item.created, _doc(item)),
    )
    return cur.rowcount > 0


def put_feed_item(item: FeedItem) -> FeedItem:
    ex(
        "UPDATE feed_items SET status=?, score=?, doc=? WHERE id=?",
        (item.status.value, item.score, _doc(item), item.id),
    )
    return item


def get_feed_item(item_id: str) -> FeedItem | None:
    return _load(FeedItem, q1("SELECT doc FROM feed_items WHERE id=?", (item_id,)))


_FEED_NEWEST = ("COALESCE(NULLIF(substr(json_extract(doc, '$.published'), 1, 10), ''), substr(created, 1, 10)) DESC, "
                "created DESC")


def list_feed(statuses: list[str] | None = None, limit: int = 200, sort: str = "",
              viewed: bool = False) -> list[FeedItem]:
    """Feed items. ``sort="recent"`` orders by publication date; otherwise by score (or insertion when unfiltered)."""
    where, params = [], []
    if statuses:
        where.append(f"status IN ({','.join('?' * len(statuses))})")
        params += statuses
    if viewed:
        where.append("json_extract(doc, '$.viewed_at') != ''")
    order = _FEED_NEWEST if sort == "recent" else ("score DESC, created DESC" if statuses else "created DESC")
    clause = f"WHERE {' AND '.join(where)} " if where else ""
    return _loads(FeedItem, q(f"SELECT doc FROM feed_items {clause}ORDER BY {order} LIMIT ?", (*params, limit)))


def put_attachment(a: Attachment) -> Attachment:
    ex("INSERT OR REPLACE INTO attachments(id, created, doc) VALUES (?,?,?)", (a.id, a.created, _doc(a)))
    return a


def get_attachment(attachment_id: str) -> Attachment | None:
    return _load(Attachment, q1("SELECT doc FROM attachments WHERE id=?", (attachment_id,)))


def put_source(src: FeedSource) -> FeedSource:
    ex(
        """INSERT INTO feed_sources(id, kind, enabled, doc) VALUES (?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, enabled=excluded.enabled, doc=excluded.doc""",
        (src.id, src.kind, int(src.enabled), _doc(src)),
    )
    return src


def list_sources() -> list[FeedSource]:
    return _loads(FeedSource, q("SELECT doc FROM feed_sources ORDER BY kind, id"))


def get_source(source_id: str) -> FeedSource | None:
    return _load(FeedSource, q1("SELECT doc FROM feed_sources WHERE id=?", (source_id,)))


def delete_source(source_id: str) -> None:
    ex("DELETE FROM feed_sources WHERE id=?", (source_id,))


# ---------------------------------------------------------------------------
# Compost
# ---------------------------------------------------------------------------


def put_compost(item: CompostItem) -> CompostItem:
    item.updated = now_iso()
    ex(
        """INSERT INTO compost(id, cluster, created, updated, doc) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET cluster=excluded.cluster, updated=excluded.updated, doc=excluded.doc""",
        (item.id, item.cluster, item.created, item.updated, _doc(item)),
    )
    return item


def get_compost(item_id: str) -> CompostItem | None:
    return _load(CompostItem, q1("SELECT doc FROM compost WHERE id=?", (item_id,)))


def list_compost() -> list[CompostItem]:
    return _loads(CompostItem, q("SELECT doc FROM compost ORDER BY created DESC"))


def delete_compost(item_id: str) -> None:
    ex("DELETE FROM compost WHERE id=?", (item_id,))


# ---------------------------------------------------------------------------
# Exploration graph
# ---------------------------------------------------------------------------


def put_node(n: ExplorationNode, dedupe_key: str | None = None) -> ExplorationNode:
    """Upsert a node. With a dedupe key, an existing node with the same key is returned instead."""
    if dedupe_key:
        row = q1("SELECT doc FROM nodes WHERE seed_id=? AND dedupe_key=?", (n.seed_id, dedupe_key))
        if row:
            existing = _load(ExplorationNode, row)
            assert existing is not None
            return existing
    ex(
        """INSERT INTO nodes(id, seed_id, round, kind, status, dedupe_key, created, doc) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET status=excluded.status, round=excluded.round, doc=excluded.doc""",
        (n.id, n.seed_id, n.round, n.kind.value, n.status.value, dedupe_key, n.created, _doc(n)),
    )
    for p in n.parents:
        add_edge(n.seed_id, p, n.id)
    return n


def get_node(node_id: str) -> ExplorationNode | None:
    return _load(ExplorationNode, q1("SELECT doc FROM nodes WHERE id=?", (node_id,)))


def list_nodes(seed_id: str, kind: str | None = None, status: str | None = None) -> list[ExplorationNode]:
    sql, params = "SELECT doc FROM nodes WHERE seed_id=?", [seed_id]
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    if status:
        sql += " AND status=?"
        params.append(status)
    return _loads(ExplorationNode, q(sql + " ORDER BY round, created", params))


def add_edge(seed_id: str, src: str, dst: str, kind: str = "grew") -> None:
    ex("INSERT OR IGNORE INTO edges(seed_id, src, dst, kind) VALUES (?,?,?,?)", (seed_id, src, dst, kind))


def list_edges(seed_id: str) -> list[dict[str, str]]:
    return [dict(r) for r in q("SELECT src, dst, kind FROM edges WHERE seed_id=?", (seed_id,))]


# ---------------------------------------------------------------------------
# Flowers, smoke checks, visuals
# ---------------------------------------------------------------------------


def put_flower(f: Flower) -> Flower:
    ex(
        "INSERT OR REPLACE INTO flowers(seed_id, version, created, doc) VALUES (?,?,?,?)",
        (f.seed_id, f.version, f.updated, _doc(f)),
    )
    return f


def latest_flower(seed_id: str) -> Flower | None:
    return _load(
        Flower, q1("SELECT doc FROM flowers WHERE seed_id=? ORDER BY version DESC LIMIT 1", (seed_id,))
    )


def flower_history(seed_id: str) -> list[Flower]:
    return _loads(Flower, q("SELECT doc FROM flowers WHERE seed_id=? ORDER BY version", (seed_id,)))


def put_smoke(s: SmokeCheck) -> SmokeCheck:
    ex(
        """INSERT INTO smoke(id, seed_id, status, created, doc) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET status=excluded.status, doc=excluded.doc""",
        (s.id, s.seed_id, s.status, s.created, _doc(s)),
    )
    return s


def get_smoke(smoke_id: str) -> SmokeCheck | None:
    return _load(SmokeCheck, q1("SELECT doc FROM smoke WHERE id=?", (smoke_id,)))


def list_smoke(seed_id: str | None = None, status: str | None = None) -> list[SmokeCheck]:
    sql, params = "SELECT doc FROM smoke WHERE 1=1", []
    if seed_id:
        sql += " AND seed_id=?"
        params.append(seed_id)
    if status:
        sql += " AND status=?"
        params.append(status)
    return _loads(SmokeCheck, q(sql + " ORDER BY created DESC", params))


def put_visual(v: Visual) -> Visual:
    ex(
        """INSERT INTO visuals(id, seed_id, kind, round, doc) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET round=excluded.round, doc=excluded.doc""",
        (v.id, v.seed_id, v.kind, v.round, _doc(v)),
    )
    return v


def list_visuals(seed_id: str) -> list[Visual]:
    return _loads(Visual, q("SELECT doc FROM visuals WHERE seed_id=? ORDER BY round DESC, kind", (seed_id,)))


# ---------------------------------------------------------------------------
# Activity log (the cross-process event stream the UI subscribes to)
# ---------------------------------------------------------------------------


def log_activity(kind: str, message: str, seed_id: str = "", data: dict[str, Any] | None = None) -> int:
    cur = ex(
        "INSERT INTO activity(created, kind, seed_id, message, data) VALUES (?,?,?,?,?)",
        (now_iso(), kind, seed_id, message, json.dumps(data or {})),
    )
    return int(cur.lastrowid or 0)


def activity_since(after_id: int, limit: int = 200) -> list[dict[str, Any]]:
    rows = q("SELECT * FROM activity WHERE id>? ORDER BY id LIMIT ?", (after_id, limit))
    return [{**dict(r), "data": json.loads(r["data"])} for r in rows]


def recent_activity(seed_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    if seed_id:
        rows = q("SELECT * FROM activity WHERE seed_id=? ORDER BY id DESC LIMIT ?", (seed_id, limit))
    else:
        rows = q("SELECT * FROM activity ORDER BY id DESC LIMIT ?", (limit,))
    return [{**dict(r), "data": json.loads(r["data"])} for r in rows][::-1]


def kv_get(key: str, default: str = "") -> str:
    row = q1("SELECT value FROM kv WHERE key=?", (key,))
    return row["value"] if row else default


def kv_set(key: str, value: str) -> None:
    ex("INSERT OR REPLACE INTO kv(key, value) VALUES (?,?)", (key, value))
