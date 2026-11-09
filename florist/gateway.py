"""Model gateway — every LLM call in Florist goes through ``complete``.

Backends (chosen by the model string, see ``config.py``):

* LiteLLM (API keys, BYOK; Meta Llama API by default)
* Claude Code subscription  (``claude-code:<model>``) — ``claude -p`` headless with ``--json-schema``
* Codex subscription        (``codex:<model>``)       — ``codex exec`` with ``--output-schema``
* ``mock``                  — deterministic, offline, schema-valid output (tests and demos)

Every call is validated against a pydantic schema (one repair retry on failure)
and logged to ``llm_calls`` with tokens, cost, latency and the loop step.
"""

from __future__ import annotations

import json
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from . import config, paths
from .schemas import now_iso
from .store import db

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


class BudgetExceeded(LLMError):
    pass


@dataclass
class Call:
    step: str
    seed_id: str = ""
    run_id: str = ""
    model: str | None = None
    allow_web: bool = False
    hints: dict[str, Any] = field(default_factory=dict)
    max_usd: float | None = None  # refuse to start if this seed already spent more
    effort: str | None = None  # reasoning effort override (minimal…max); None → role default


@dataclass
class Raw:
    text: str
    structured: Any = None
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backend_of(model: str) -> str:
    if model == "mock" or model.startswith("mock:"):
        return "mock"
    if model.startswith("claude-code:") or model == "claude-code":
        return "claude-code"
    if model.startswith("codex:") or model == "codex":
        return "codex"
    if model.startswith("meta/"):
        return "meta"
    return "litellm"


def complete(call: Call, system: str, user: str, schema: type[T]) -> T:
    """Run one structured call and return a validated instance of ``schema``."""
    model = call.model or config.model_for(call.step)
    if call.max_usd is not None and call.seed_id and spent(seed_id=call.seed_id) >= call.max_usd:
        raise BudgetExceeded(f"seed budget ${call.max_usd:.2f} exhausted")
    schema_json = inline_schema(schema)
    attempts = 1 + max(0, config.get().models.max_retries)
    prompt = user
    last_err = ""
    for attempt in range(attempts):
        t0 = time.monotonic()
        try:
            raw = _dispatch(model, call, system, prompt, schema, schema_json)
        except Exception as e:  # backend failure: log and surface
            _log(call, model, Raw(""), int((time.monotonic() - t0) * 1000), ok=False, error=str(e)[:500])
            raise LLMError(f"{backend_of(model)} call failed for step '{call.step}': {e}") from e
        latency = int((time.monotonic() - t0) * 1000)
        try:
            data = raw.structured if raw.structured is not None else extract_json(raw.text)
            result = schema.model_validate(data)
            _log(call, model, raw, latency, ok=True)
            return result
        except (ValidationError, ValueError) as e:
            last_err = _short_error(e)
            _log(call, model, raw, latency, ok=False, error=last_err)
            prompt = (
                f"{user}\n\n---\nYour previous answer did not validate against the schema:\n{last_err}\n"
                f"Previous answer:\n{(raw.text or json.dumps(raw.structured))[:4000]}\n"
                "Return only corrected JSON that satisfies the schema."
            )
    raise LLMError(f"step '{call.step}' output failed validation after {attempts} attempts: {last_err}")


def complete_text(call: Call, system: str, user: str) -> str:
    """Free-text completion (used rarely; structured calls are preferred)."""

    class _Text(BaseModel):
        text: str

    return complete(call, system, user + "\n\nReturn JSON: {\"text\": \"...\"}", _Text).text


def spent(seed_id: str | None = None, since: str | None = None, run_id: str | None = None) -> float:
    sql, params = "SELECT COALESCE(SUM(cost_usd),0) AS c FROM llm_calls WHERE 1=1", []
    if seed_id:
        sql += " AND seed_id=?"
        params.append(seed_id)
    if run_id:
        sql += " AND run_id=?"
        params.append(run_id)
    if since:
        sql += " AND created>=?"
        params.append(since)
    row = db.q1(sql, params)
    return float(row["c"] if row else 0.0)


def usage_summary(seed_id: str | None = None) -> dict[str, Any]:
    where, params = ("WHERE seed_id=?", [seed_id]) if seed_id else ("", [])
    rows = db.q(
        f"""SELECT step, backend, model, COUNT(*) n, SUM(input_tokens) tin, SUM(output_tokens) tout,
                   SUM(cost_usd) usd, SUM(1-ok) failed, AVG(latency_ms) ms
            FROM llm_calls {where} GROUP BY step, backend, model ORDER BY usd DESC""",
        params,
    )
    tot = db.q1(
        f"SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout, "
        f"COALESCE(SUM(cost_usd),0) usd FROM llm_calls {where}",
        params,
    )
    return {
        "total": dict(tot) if tot else {},
        "by_step": [dict(r) for r in rows],
    }


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def _dispatch(model: str, call: Call, system: str, user: str, schema: type[BaseModel], schema_json: dict) -> Raw:
    kind = backend_of(model)
    if kind == "mock":
        return _mock(schema_json, call)
    if kind == "claude-code":
        return _claude_code(model, call, system, user, schema_json,
                            call.effort if call.effort is not None else config.effort_for(call.step))
    effort = call.effort if call.effort is not None else config.effort_for(call.step)
    if kind == "meta":
        return _meta(model, system, user, schema_json, effort)
    if kind == "codex":
        return _codex(model, system, user, schema_json, effort)
    return _litellm(model, system, user, schema_json, effort)


def _json_instructions(schema_json: dict) -> str:
    return (
        "\n\n## Output format\nReturn ONLY a JSON object (no prose, no markdown fences) that validates "
        "against this JSON Schema:\n" + json.dumps(schema_json, ensure_ascii=False)
    )


def _litellm(model: str, system: str, user: str, schema_json: dict, effort: str = "") -> Raw:
    import litellm  # heavy import, keep lazy

    litellm.suppress_debug_info = True
    litellm.drop_params = True  # providers without reasoning_effort simply ignore it
    s = config.get().models
    messages = [
        {"role": "system", "content": system + _json_instructions(schema_json)},
        {"role": "user", "content": user},
    ]
    kwargs: dict[str, Any] = dict(model=model, messages=messages, temperature=s.temperature, timeout=s.timeout_s)
    if effort:
        kwargs["reasoning_effort"] = {"max": "high", "xhigh": "high"}.get(effort, effort)
    try:
        resp = litellm.completion(response_format={"type": "json_object"}, **kwargs)
    except Exception as e:  # provider may not support response_format
        if "response_format" not in str(e).lower() and "json" not in str(e).lower():
            raise
        resp = litellm.completion(**kwargs)
    text = resp.choices[0].message.content or ""
    usage = getattr(resp, "usage", None)
    tin = int(getattr(usage, "prompt_tokens", 0) or 0)
    tout = int(getattr(usage, "completion_tokens", 0) or 0)
    try:
        cost = float(litellm.completion_cost(completion_response=resp) or 0.0)
    except Exception:
        cost = 0.0
    return Raw(text=text, input_tokens=tin, output_tokens=tout, cost_usd=cost)


def find_binary(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    if os.name == "nt":
        for cand in (
            Path(os.environ.get("APPDATA", "")) / "npm" / f"{name}.cmd",
            Path.home() / ".local" / "bin" / f"{name}.exe",
        ):
            if cand.exists():
                return str(cand)
    return None


def _agent_cwd() -> Path:
    # Run harnesses in an empty folder so a project's CLAUDE.md / AGENTS.md is not picked up.
    return paths.sub("agent-cwd")


def _claude_code(model: str, call: Call, system: str, user: str, schema_json: dict, effort: str = "") -> Raw:
    exe = find_binary("claude")
    if not exe:
        raise LLMError("`claude` not found on PATH — install Claude Code and sign in once with `claude`")
    sub_model = model.split(":", 1)[1] if ":" in model else ""
    tools = "WebSearch,WebFetch" if call.allow_web else ""
    cmd = [
        exe, "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--system-prompt", system,
        "--json-schema", json.dumps(schema_json),
        "--tools", tools,
    ]
    if call.allow_web:
        cmd += ["--allowedTools", "WebSearch", "WebFetch"]
    if sub_model:
        cmd += ["--model", sub_model]
    if effort:
        cmd += ["--effort", {"minimal": "low"}.get(effort, effort)]
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    proc = subprocess.run(
        cmd,
        input=user,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=config.get().models.timeout_s * (3 if call.allow_web else 1),
        cwd=_agent_cwd(),
        env=env,
    )
    out = proc.stdout.strip()
    if not out:
        raise LLMError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:400]}")
    try:
        env_json = json.loads(out.splitlines()[-1] if not out.startswith("{") else out)
    except json.JSONDecodeError as e:
        raise LLMError(f"unexpected claude output: {out[:300]}") from e
    if env_json.get("is_error"):
        raise LLMError(f"claude error: {str(env_json.get('result'))[:400]}")
    u = env_json.get("usage") or {}
    tin = int(u.get("input_tokens", 0)) + int(u.get("cache_read_input_tokens", 0)) + int(
        u.get("cache_creation_input_tokens", 0)
    )
    return Raw(
        text=env_json.get("result") or "",
        structured=env_json.get("structured_output"),
        input_tokens=tin,
        output_tokens=int(u.get("output_tokens", 0)),
        # Under a subscription this is Claude Code's notional list cost; still the right meter.
        cost_usd=float(env_json.get("total_cost_usd") or 0.0),
    )


def _codex(model: str, system: str, user: str, schema_json: dict, effort: str = "") -> Raw:
    exe = find_binary("codex")
    if not exe:
        raise LLMError("`codex` not found on PATH — install the Codex CLI and sign in once")
    sub_model = model.split(":", 1)[1] if ":" in model else ""
    with tempfile.TemporaryDirectory() as td:
        schema_file = Path(td) / "schema.json"
        out_file = Path(td) / "last.txt"
        schema_file.write_text(json.dumps(_strict_for_openai(schema_json)), encoding="utf-8")
        cmd = [
            exe, "exec", "--skip-git-repo-check", "--sandbox", "read-only",
            "--output-schema", str(schema_file), "-o", str(out_file),
        ]
        if sub_model:
            cmd += ["-m", sub_model]
        if effort:
            cmd += ["-c", f"model_reasoning_effort={ {'max': 'high', 'xhigh': 'high'}.get(effort, effort) }"]
        cmd.append("-")
        prompt = f"{system}\n\n---\n\n{user}"
        proc = subprocess.run(
            cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=config.get().models.timeout_s * 2, cwd=_agent_cwd(),
        )
        text = out_file.read_text(encoding="utf-8") if out_file.exists() else ""
        if not text:
            raise LLMError(f"codex exited {proc.returncode}: {proc.stderr.strip()[-400:]}")
    # codex exec does not report usage on this path; estimate (~4 chars/token).
    return Raw(text=text, input_tokens=len(prompt) // 4, output_tokens=len(text) // 4)


# Per-1M-token list prices (Meta Model API docs / pricing page, Nov 2026). Unknown models fall back to 1.3.
META_PRICES: dict[str, tuple[float, float, float]] = {  # input, cached input, output
    "muse-spark-1.3": (1.25, 0.15, 4.25), "muse-spark-1.1": (1.25, 0.15, 4.25), "muse-spark-1.2": (1.25, 0.15, 4.25),
    "muse-spark-1.3-contributor": (0.10, 0.002, 0.20), "muse-spark-1.2-contributor": (0.10, 0.002, 0.20),
}


def _meta(model: str, system: str, user: str, schema_json: dict, effort: str = "") -> Raw:
    """Meta Model API (api.meta.ai) — OpenAI-compatible chat completions with strict JSON-schema output."""
    import httpx

    key = config.key_for("meta")
    if not key:
        raise LLMError("no Meta Model API key — add it in Settings → Models (MODEL_API_KEY)")
    model_id = model.split("/", 1)[1]
    body: dict[str, Any] = {
        "model": model_id,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "florist_output", "schema": _strict_for_openai(schema_json), "strict": True}},
        "max_completion_tokens": 16000,
    }
    if effort:
        body["reasoning_effort"] = effort
    s = config.get().models
    url = f"{config.META_BASE_URL}/chat/completions"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=s.timeout_s) as c:
        r = c.post(url, headers=headers, json=body)
        if r.status_code == 400 and ("schema" in r.text.lower() or "response_format" in r.text.lower()):
            # schema the strict validator dislikes: fall back to plain JSON instructions
            body.pop("response_format")
            body["messages"][0]["content"] = system + _json_instructions(schema_json)
            r = c.post(url, headers=headers, json=body)
        if r.status_code == 400 and "reasoning" in r.text.lower() and "reasoning_effort" in body:
            body.pop("reasoning_effort")  # model without effort control
            r = c.post(url, headers=headers, json=body)
    if r.status_code >= 400:
        raise LLMError(f"Meta Model API HTTP {r.status_code}: {r.text[:300]}")
    d = r.json()
    msg = (d.get("choices") or [{}])[0].get("message") or {}
    if msg.get("refusal"):
        raise LLMError(f"Meta model refused: {msg['refusal'][:200]}")
    u = d.get("usage") or {}
    tin, tout = int(u.get("prompt_tokens", 0)), int(u.get("completion_tokens", 0))
    cached = int((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0))
    p_in, p_cache, p_out = META_PRICES.get(model_id, META_PRICES["muse-spark-1.3"])
    cost = ((tin - cached) * p_in + cached * p_cache + tout * p_out) / 1e6
    return Raw(text=msg.get("content") or "", input_tokens=tin, output_tokens=tout, cost_usd=cost)


def _strict_for_openai(schema: dict) -> dict:
    """OpenAI structured outputs want additionalProperties:false and every property required."""
    s = json.loads(json.dumps(schema))

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"].keys())
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(s)
    return s


# ---------------------------------------------------------------------------
# Mock backend: schema-driven, deterministic, uses hints for valid references
# ---------------------------------------------------------------------------

_MOCK_WORDS = [
    "adaptive", "sparse", "baseline", "distilled", "streaming", "lightweight", "benchmark",
    "visual", "retrieval", "on-device", "curriculum", "probe", "toolkit", "pipeline",
]
_SMOKE_CODE = (
    "import json, time\n"
    "t = time.perf_counter()\n"
    "total = sum(i * i for i in range(200000))\n"
    "elapsed = time.perf_counter() - t\n"
    "print('sum of squares computed', total)\n"
    "print('SMOKE_RESULT ' + json.dumps({'elapsed_s': round(elapsed, 4), 'ok': 1}))\n"
)


def _mock(schema: dict, call: Call) -> Raw:
    rnd = random.Random(f"{call.step}:{call.seed_id}:{json.dumps(call.hints, sort_keys=True)[:2000]}")
    value = _fake(schema, call.hints, rnd, name="root", depth=0)
    text = json.dumps(value)
    return Raw(text=text, structured=value, input_tokens=200, output_tokens=len(text) // 4)


def _fake(s: dict, hints: dict, rnd: random.Random, name: str, depth: int, index: int = 0) -> Any:
    words = hints.get("words") or _MOCK_WORDS
    if "anyOf" in s:
        non_null = [x for x in s["anyOf"] if x.get("type") != "null"]
        return _fake(non_null[0], hints, rnd, name, depth, index) if non_null else None
    if "enum" in s:
        return s["enum"][index % len(s["enum"])] if name in ("tier_suggestion",) else s["enum"][0]
    if "const" in s:
        return s["const"]
    t = s.get("type")
    if t == "object":
        props = s.get("properties", {})
        out: dict[str, Any] = {}
        for k, sub in props.items():
            out[k] = _fake(sub, hints, rnd, k, depth + 1, index)
        if "ref" in props and hints.get("refs"):
            out["ref"] = hints["refs"][index % len(hints["refs"])]
        return out
    if t == "array":
        item = s.get("items", {})
        lo = s.get("minItems", 0)
        hi = s.get("maxItems", 4)
        if name in ("checks", "ranking", "notes", "items") and hints.get("refs"):
            n = len(hints["refs"])
        elif name in ("evidence", "closest_work"):
            pool = hints.get("evidence") or []
            if not pool:
                return []
            return [
                {"ref": pool[(index + j) % len(pool)], "quote": "supporting detail", "title": "",
                 "how_it_differs": "targets a different setting"}
                for j in range(min(2, len(pool)))
            ]
        elif name in ("compost_ids",) and hints.get("compost"):
            return hints["compost"][: max(2, lo)]
        elif name == "feed_ids" and hints.get("feed"):
            return hints["feed"][: max(1, lo)]
        elif name in ("related_seed_ids", "inspired_by", "parents"):
            return []
        elif name == "steps":
            n = 4
        elif name == "edges":
            return [{"source": f"s{i}", "target": f"s{i + 1}", "label": ""} for i in range(1, 4)]
        else:
            n = max(lo, min(hi, 3))
        n = max(lo, min(hi, n)) if hi else max(lo, n)
        return [_fake(item, hints, rnd, name, depth + 1, i) for i in range(n)]
    if t == "number":
        lo = s.get("minimum", 0)
        hi = s.get("maximum", 1)
        return round(rnd.uniform(max(lo, 0.25), min(hi, 0.9)), 2)
    if t == "integer":
        lo = s.get("minimum", 1)
        hi = s.get("maximum", lo + 4)
        if name == "rank":
            return index + 1
        if name == "timeout_s":
            return 30
        return max(lo, min(hi, lo + index))
    if t == "boolean":
        return name != "keep" or index < 2
    if t == "string":
        if name == "id":
            return f"s{index + 1}"
        if name == "code":
            return _SMOKE_CODE
        if name in ("source", "target"):
            return f"s{index + 1}"
        if name in ("evolves", "node_id", "direction_ref", "gap_ref"):
            return ""
        if name in ("ref",) and hints.get("refs"):
            return hints["refs"][index % len(hints["refs"])]
        if "pattern" in s:
            return f"s{index + 1}"
        topic = hints.get("topic") or "the idea"
        w = words[(index + depth + 3 * int(hints.get("round") or 0)) % len(words)]
        base = {
            "title": f"{w.capitalize()} {topic}"[:60],
            "label": f"{w} step"[:40],
            "query": f"{topic} {w}",
            "reply": f"Noted. I will take that into account for {topic}.",
            "metric": "task success rate on a held-out set (higher is better)",
        }.get(name, f"{w.capitalize()} {name.replace('_', ' ')} for {topic}.")
        max_len = s.get("maxLength")
        return base[:max_len] if max_len else base
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def inline_schema(model: type[BaseModel]) -> dict:
    """JSON Schema with all $refs inlined (some CLIs reject $defs)."""
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].split("/")[-1]
                merged = {**resolve(defs[name]), **{k: v for k, v in node.items() if k != "$ref"}}
                return merged
            return {k: resolve(v) for k, v in node.items() if k not in ("title",) or not isinstance(v, str)}
        if isinstance(node, list):
            return [resolve(x) for x in node]
        return node

    return resolve(raw)


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> Any:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty response")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = _FENCE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    raise ValueError("no JSON object found in response")


def _short_error(e: Exception) -> str:
    if isinstance(e, ValidationError):
        parts = [f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()[:8]]
        return "; ".join(parts)
    return str(e)[:400]


def _log(call: Call, model: str, raw: Raw, latency: int, ok: bool, error: str = "") -> None:
    try:
        db.ex(
            """INSERT INTO llm_calls(created, step, seed_id, run_id, backend, model, input_tokens, output_tokens,
                                     cost_usd, latency_ms, ok, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (now_iso(), call.step, call.seed_id, call.run_id, backend_of(model), model, raw.input_tokens,
             raw.output_tokens, raw.cost_usd, latency, int(ok), error),
        )
    except Exception:
        pass


def check_backend(model: str | None = None) -> dict[str, Any]:
    """Cheap readiness probe for the settings page / `florist models test`."""
    model = model or config.get().models.default
    kind = backend_of(model)
    info: dict[str, Any] = {"model": model, "backend": kind}
    if kind == "claude-code":
        info["ready"] = bool(find_binary("claude"))
        info["detail"] = "claude CLI found" if info["ready"] else "install Claude Code"
    elif kind == "codex":
        info["ready"] = bool(find_binary("codex"))
        info["detail"] = "codex CLI found" if info["ready"] else "install the Codex CLI"
    elif kind == "mock":
        info["ready"], info["detail"] = True, "offline mock model"
    elif kind == "meta":
        info["ready"] = bool(config.key_for("meta"))
        info["detail"] = "MODEL_API_KEY set" if info["ready"] else "MODEL_API_KEY missing"
    else:
        provider = model.split("/", 1)[0] if "/" in model else "openai"
        has = bool(config.key_for(provider)) or provider in ("ollama", "lm_studio", "hosted_vllm")
        info["ready"] = has
        info["detail"] = f"{config.KEY_ENV.get(provider, provider.upper() + '_API_KEY')} {'set' if has else 'missing'}"
    return info
