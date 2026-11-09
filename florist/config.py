"""Machine settings (``~/.florist/settings.yaml``): model routing, keys, server.

Model strings
-------------
* ``claude-code:<model>``  — run through the user's Claude Code subscription
  (``claude -p`` headless, structured output via ``--json-schema``).
* ``codex:<model>``        — run through the Codex CLI subscription (``codex exec``).
* ``mock``                 — deterministic offline model (tests, demos).
* anything else            — a LiteLLM model string, e.g.
* ``meta/<model>``          — Meta Model API (api.meta.ai), e.g. ``meta/muse-spark-1.3`` (default),
  ``meta/muse-wonder-1.0``; strict JSON-schema output and ``reasoning_effort``.
* LiteLLM strings for everything else, e.g.
  ``anthropic/claude-sonnet-5-5``, ``openai/gpt-5``, ``ollama/llama3.3``.

Roles map loop steps to models: ``fast`` (grounding, triage, summaries) and
``strong`` (critique, exploit, flower, pick). Keys are read from the
environment first, then from ``settings.yaml`` ``keys:`` (BYOK).
"""

from __future__ import annotations

import os
from typing import Any

import yaml
from pydantic import BaseModel, Field

from . import paths

DEFAULT_MODEL = "meta/muse-spark-1.3"
DEFAULT_FAST = "meta/muse-spark-1.3"
META_BASE_URL = "https://api.meta.ai/v1"

# Which role each step runs with.
STEP_ROLES: dict[str, str] = {
    "ground": "fast",
    "triage": "fast",
    "feed_triage": "fast",
    "compost": "fast",
    "clusters": "fast",
    "followups": "fast",
    "explore": "strong",
    "check": "strong",
    "smoke": "strong",
    "visualize": "strong",
    "exploit": "strong",
    "flower": "strong",
    "pick": "strong",
    "mining": "strong",
    "taste": "strong",
    "chat": "ideate",
    "ideate": "ideate",
    "seed_from_chat": "strong",
    "profile_sync": "fast",
    "literature_plan": "fast",
    "literature_review": "strong",
    "novelty": "strong",
    "find_sources": "ideate",
    "feed_ideas": "strong",
    "polish": "ideate",
}

KEY_ENV = {
    "meta": "MODEL_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "groq": "GROQ_API_KEY",
    "together_ai": "TOGETHERAI_API_KEY",
    "github": "GITHUB_TOKEN",
    "openalex": "OPENALEX_API_KEY",
    "semantic_scholar": "S2_API_KEY",
    "twitter": "X_BEARER_TOKEN",
}


class ModelSettings(BaseModel):
    default: str = DEFAULT_MODEL
    fast: str = DEFAULT_FAST
    strong: str = DEFAULT_MODEL
    ideate: str = ""  # empty → strong
    effort: dict[str, str] = Field(default_factory=lambda: {"ideate": "low", "fast": "low", "strong": "medium"},
                                   description="reasoning effort per role ('' = let the model decide)")
    temperature: float = 0.4
    timeout_s: int = 240
    max_retries: int = 1


class EmailSettings(BaseModel):
    imap_host: str = ""
    imap_port: int = 993
    username: str = ""
    folder: str = "Florist"
    local_dir: str = Field("", description="read .eml/.mbox files from here instead of IMAP")


class UISettings(BaseModel):
    character_animations: bool = Field(False, description="animated Florist character instead of standard spinners")


class Settings(BaseModel):
    models: ModelSettings = Field(default_factory=ModelSettings)
    keys: dict[str, str] = Field(default_factory=dict)
    port: int = 4795
    research_order: list[str] = Field(
        default_factory=lambda: ["alphaxiv", "openalex", "arxiv", "semantic_scholar", "agent_web"]
    )
    cache_ttl_days: int = 7
    email: EmailSettings = Field(default_factory=EmailSettings)
    smoke_enabled: bool = True
    auto_fetch_feed: bool = True
    mining_every_days: int = 7
    ui: UISettings = Field(default_factory=UISettings)


_cache: Settings | None = None


def _migrate(data: dict) -> bool:
    """The Llama API (api.llama.com) was retired in July 2026; its keys and models moved to the Meta Model API."""
    changed = False
    keys = data.get("keys") or {}
    if keys.get("meta_llama") and not keys.get("meta"):
        keys["meta"] = keys.pop("meta_llama")
        changed = True
    for role, val in list((data.get("models") or {}).items()):
        if isinstance(val, str) and val.startswith("meta_llama/"):
            data["models"][role] = DEFAULT_MODEL
            changed = True
    return changed


def load() -> Settings:
    global _cache
    p = paths.settings_path()
    if p.exists():
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        migrated = _migrate(data)
        _cache = Settings.model_validate(data)
        if migrated:
            save(_cache)
    else:
        _cache = Settings()
        save(_cache)
    _export_keys(_cache)
    return _cache


def get() -> Settings:
    return _cache or load()


def save(s: Settings) -> None:
    global _cache
    p = paths.settings_path()
    p.write_text(yaml.safe_dump(s.model_dump(), sort_keys=False, allow_unicode=True), encoding="utf-8")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    _cache = s
    _export_keys(s)


def update(patch: dict[str, Any]) -> Settings:
    cur = get().model_dump()
    _deep_merge(cur, patch)
    s = Settings.model_validate(cur)
    save(s)
    return s


def _deep_merge(dst: dict, src: dict) -> None:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v


def _export_keys(s: Settings) -> None:
    """Expose BYOK keys from settings.yaml to LiteLLM via env, never overriding real env."""
    for provider, key in s.keys.items():
        env = KEY_ENV.get(provider, provider.upper())
        if key and not os.environ.get(env):
            os.environ[env] = key


def effort_for(step: str) -> str:
    role = STEP_ROLES.get(step, "default")
    role = "strong" if role == "default" else role
    return get().models.effort.get(role, "")


def key_for(provider: str) -> str:
    env = KEY_ENV.get(provider, provider.upper())
    return os.environ.get(env) or get().keys.get(provider, "")


def model_for(step: str) -> str:
    s = get().models
    role = STEP_ROLES.get(step, "default")
    if role == "ideate":
        return s.ideate or s.strong or s.default
    return getattr(s, role, None) or s.default


def redacted() -> dict[str, Any]:
    d = get().model_dump()
    d["keys"] = {k: ("•••" + v[-4:] if len(v) > 4 else "•••") for k, v in d["keys"].items() if v}
    d["keys_present"] = {p: bool(key_for(p)) for p in KEY_ENV}
    return d
