<div align="center">

<img src="app/public/florist-icon.png" width="72" alt="" />

# Florist

**Florist grows ideas.** It gathers what inspires you, keeps it in one place, and turns the ideas you
care about into explored, visualized, ready-to-run project plans for tools like OpenResearch and
Co-Scientist.

</div>

```
 sources ──► feed ──► compost ◄──► greenhouse ──► exploration loop ──► flower ──► flower pack
 (papers,    (ranked   (everything     (seeds by     ground → explore → check    (findings    (OpenResearch program.md,
  repos,     against   you can't       tier)         → smoke → exploit →         with         Co-Scientist goal, build
  videos,    your      commit to                     visualize → flower          evidence)    plan, AGENTS.md)
  mail…)     seeds)    yet)
```

Florist covers the stage *before* execution: finding inspiration, keeping it, checking whether an
idea is new and doable for **you**, and exploring technologies until it is ready to hand off. It is
local-first (SQLite + files in `~/.florist`), runs on **Meta's Muse models** by default (Muse Spark and
Muse Wonder on the Meta Model API) and works with any other model, and is drivable three ways:

| Drive it from | How |
|---|---|
| **Desktop / browser** | `florist app` (native window) or `florist up` (dashboard at `http://127.0.0.1:4795`) |
| **Terminal** | `florist …` — every command has `--json` |
| **A coding agent** | Muse Code, Claude Code, Codex, Cursor… via `florist mcp install`, `florist skills install`, or `florist agent` |

## Quick start

```sh
# 1. install (Python ≥ 3.11, uv)
uv sync --extra desktop
cd app && pnpm install && pnpm build && cd ..      # the UI (optional for CLI-only use)

# 2. choose a model — Meta's Muse models by default (key from https://dev.meta.ai/api-keys/)
uv run florist init --model meta/muse-spark-1.3
uv run florist models key meta <MODEL_API_KEY>
# or: meta/muse-wonder-1.0 · claude-code:sonnet (subscription) · codex:gpt-5 · anthropic/… · ollama/… · mock

# 3. tell Florist about you, plant a seed, grow it, pick it
uv run florist profile edit
uv run florist seed add "Speculative decoding with a tiny draft model on my 4090" --tier personal --ask
uv run florist grow speculative --rounds 2
uv run florist flower speculative
uv run florist pick speculative          # → ~/.florist/packs/flower-…/ with adapters/openresearch/program.md
uv run florist app                       # or explore it all in the desktop app
```

A real end-to-end example — seed → 2 rounds → picked pack — is in [`examples/`](examples/).

### Standalone desktop app

Build a double-clickable app that bundles Python, the sidecar and the UI (PyInstaller):

```sh
cd app && pnpm build && cd ..
uv run python scripts/build_desktop.py     # → dist/Florist/Florist.exe (Windows) · run on macOS/Linux for those
```

## Models

| Provider | How | Notes |
|---|---|---|
| **Meta Model API** (default) | `meta/muse-spark-1.3`, `meta/muse-wonder-1.0`, `meta/muse-spark-1.3-contributor` | Strict JSON-schema output, reasoning effort minimal → max, 1M context. Key: `MODEL_API_KEY`. Replaces the retired Llama API — old Llama API keys in settings migrate automatically. |
| Coding subscriptions | `claude-code:sonnet`, `codex:gpt-5` | Runs the CLI headless; no API key. |
| Any other API | `anthropic/…`, `openai/…`, `gemini/…`, `openrouter/…`, `ollama/…` | Via LiteLLM. |

Three roles — *Ideate* (chats), *Fast* (search, triage, summaries) and *Strong* (critique, ranking,
the flower) — each with its own model and effort; the chat composer lets you pick both per message.

## What's inside

The app follows one layout everywhere: navigation on the left, the work in the middle, and an
inspector on the right that shows details only when you select something.

- **Ideate** (the landing page) — a chat for ideas that aren't projects yet. Drag feed items,
  compost or papers onto it for context; toggle literature search, novelty check, or compost/feed
  recall per message; pick the model; talk with voice. **Turn into a seed** when it clicks.
- **Seeds** — each seed opens the same chat, plus views for the exploration **graph**, the
  **flower**, **visuals**, and a **PDF reader** for the papers it found (side by side if you like).
  The inspector holds the seed's papers, repos, experiments, artifacts and related compost.
  Steer a running round or drop in a new idea mid-search.
- **Greenhouse** — every seed with its stage (seed → growing → flower, judged by Florist), quick
  settings, and a page per seed: an editable **spec sheet** the loop reads every round, conference
  targets and deadline, connected files, **Pick** (at any stage), and a GitHub-style activity map.
- **Compost** — an editable table and a theme graph; drag rows into Ideate or onto a seed; select
  several to start a seed.
- **Feed** — papers (arXiv, alphaXiv, bioRxiv, Hugging Face), conference proceedings, popular and new
  GitHub repos and Hugging Face models, Hacker News, Reddit, X, Bluesky, Mastodon, YouTube, Medium,
  Hackster.io and RSS, each with its logo. **All** and **Viewed** views, newest first; one funnel
  holds sorting, date, category and source filters. **I'm feeling lucky** opens an Ideate chat about something good.
- **Settings** — your profile as **one markdown document** (`profile.md`, paste from anywhere;
  Florist keeps one section of learned notes and its own YAML in sync), models by provider with
  roles for Ideate / Fast / Strong, feed sources, statistics, and docs.
- **Auto-grow** — run / scheduled / stop for background growth, at the bottom of the sidebar.

Under the hood: a research loop grounded in real retrieval with novelty and feasibility checks,
smoke checks that only run with your approval, findings that must cite real sources, a preference
model learned from what you do, and flower packs with adapters for OpenResearch, Co-Scientist, a
build plan and coding agents.

## Repository layout

```
florist/        Python sidecar + CLI (FastAPI, SQLite, gateway, loop, ingest, MCP)
  agent/        loop, preferences, greenhouse, compost, visuals, smoke sandbox, pack, scheduler
  ingest/       feed sources and triage
  store/        SQLite migrations and document store
app/            React + TypeScript + Tailwind UI (dnd-kit, React Flow, Mermaid, Plotly)
schemas/        JSON Schemas for every record and agent output (generated: `florist schemas`)
skills/         prompts and rubrics per loop step (also served to coding agents)
adapters/       flower pack → OpenResearch, Co-Scientist, build plan, CLAUDE.md (Jinja templates)
examples/       a picked flower pack from a real run
scripts/        standalone desktop build (PyInstaller)
hackathon/      demo video script, recording tooling, submission answers
docs/           guide, architecture, evaluation protocol
tests/          offline test suite (mock model, fake research layer)
```

See [docs/guide.md](docs/guide.md) for the user guide, [docs/architecture.md](docs/architecture.md)
for how it works, [SKILL.md](SKILL.md) for coding agents, and [ASSUMPTIONS.md](ASSUMPTIONS.md) for
decisions made where the spec was open.

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```sh
uv run pytest                 # offline: mock model + fake research layer
uv run florist schemas        # regenerate schemas/ after changing florist/schemas.py
cd app && pnpm dev            # UI on :5173, proxies /api and /ws to `florist up` on :4795
```
