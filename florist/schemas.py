"""Florist schemas — the single source of truth.

Every record Florist stores and every structured output an agent (API model,
Claude Code, Codex, or an external coding agent driving the CLI) produces is
validated against one of these models. ``florist schemas export`` writes them
as JSON Schema files into ``schemas/`` so non-Python tools can validate too.

Two groups:

* **Records** (spec section 11.2): Seed, FeedItem, CompostItem, ExplorationNode,
  Flower, FlowerPack, Profile (+ a few supporting records).
* **Step outputs**: what each skill must return (GroundPlan, ExploreOutput, ...).
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from . import SCHEMA_VERSION


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class Tier(str, Enum):
    exploration = "exploration"
    personal = "personal"
    formal = "formal"


class SeedState(str, Enum):
    candidate = "candidate"  # proposed by compost mining, not yet accepted
    dormant = "dormant"
    growing = "growing"
    flowering = "flowering"
    picked = "picked"
    composted = "composted"


class NodeKind(str, Enum):
    seed = "seed"
    source = "source"
    technology = "technology"
    direction = "direction"
    check = "check"
    smoke = "smoke"
    visual = "visual"
    finding = "finding"


class NodeStatus(str, Enum):
    active = "active"
    top = "top"  # selected for exploitation / recommended
    pruned = "pruned"


class FeedStatus(str, Enum):
    new = "new"
    kept = "kept"
    folded = "folded"
    composted = "composted"
    seeded = "seeded"
    attached = "attached"
    dismissed = "dismissed"


# ---------------------------------------------------------------------------
# Profile (section 8)
# ---------------------------------------------------------------------------


class Resources(Model):
    compute: str = Field("", description="e.g. '1x RTX 4090, no cluster'")
    budget_usd_month: float = Field(0, ge=0, description="API budget per month in USD")
    notes: str = ""


class TimeBudget(Model):
    hours_per_week: float = Field(5, ge=0)
    goal_date: str = Field("", description="ISO date or free text, e.g. 'NeurIPS 2027'")
    goal_label: str = ""


class DowntimeWindow(Model):
    days: list[Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]] = Field(
        default_factory=lambda: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    )
    start: str = Field("01:00", pattern=r"^\d{2}:\d{2}$")
    end: str = Field("07:00", pattern=r"^\d{2}:\d{2}$")


class Downtime(Model):
    mode: Literal["run", "scheduled", "stop"] = Field(
        "stop", description="run: grow queued seeds now; scheduled: only in windows; stop: never")
    enabled: bool = Field(False, description="deprecated; use mode")
    windows: list[DowntimeWindow] = Field(default_factory=lambda: [DowntimeWindow()])
    max_usd_per_window: float = Field(1.0, ge=0, description="Florist's own token-log meter")
    subscription_fraction: float = Field(
        0.2, ge=0, le=1, description="Share of a coding subscription Florist may use (advisory)"
    )


class LearnedPreference(Model):
    """A preference Florist learned from behaviour. Always visible and editable."""

    id: str
    kind: Literal["tag", "technology", "source", "statement"]
    key: str = Field(..., description="tag / technology / source name, or the statement text")
    weight: float = Field(0.0, ge=-1, le=1, description="-1 avoid … +1 seek out")
    evidence: int = Field(0, ge=0, description="number of behavioural signals behind it")
    locked: bool = Field(False, description="user-edited: Florist will not change it")
    note: str = ""
    updated: str = Field(default_factory=now_iso)


class Profile(Model):
    schema_version: str = SCHEMA_VERSION
    name: str = ""
    interests: list[str] = Field(default_factory=list)
    proficient_in: list[str] = Field(default_factory=list)
    wants_to_learn: list[str] = Field(default_factory=list)
    resources: Resources = Field(default_factory=Resources)
    time: TimeBudget = Field(default_factory=TimeBudget)
    conference_targets: list[str] = Field(
        default_factory=list, description="AI Deadlines conference ids or titles, e.g. 'neurips'"
    )
    work_preferences: list[str] = Field(default_factory=list)
    downtime: Downtime = Field(default_factory=Downtime)
    compost_after_days: int = Field(
        45, ge=1, description="seeds at lowest priority longer than this move to compost"
    )
    feed_fold_threshold: float = Field(0.35, ge=0, le=1)
    learned_preferences: list[LearnedPreference] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Seeds (section 5)
# ---------------------------------------------------------------------------


class Constraints(Model):
    time: str = ""
    compute: str = ""
    skills: str = ""
    must_use: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    notes: str = ""


class FollowUp(Model):
    question: str
    answer: str = ""


class SeedBudget(Model):
    max_rounds: int = Field(3, ge=1, le=20)
    max_usd: float = Field(2.0, ge=0)


class Seed(Model):
    id: str
    slug: str
    title: str
    prompt: str = Field(..., description="what the idea is about, a sentence or a paragraph")
    tier: Tier = Tier.personal
    state: SeedState = SeedState.dormant
    priority: int = Field(3, ge=1, le=5, description="1 = lowest, 5 = highest")
    technologies: list[str] = Field(default_factory=list)
    related_papers: list[str] = Field(default_factory=list)
    compost_ids: list[str] = Field(default_factory=list)
    feed_ids: list[str] = Field(default_factory=list)
    attachment_ids: list[str] = Field(default_factory=list, description="files the user attached")
    constraints: Constraints = Field(default_factory=Constraints)
    followups: list[FollowUp] = Field(default_factory=list)
    passive: bool = Field(False, description="queued for background growth during downtime")
    budget: SeedBudget = Field(default_factory=SeedBudget)
    origin: Literal["manual", "feed", "compost", "mining", "ideate"] = "manual"
    conference_targets: list[str] = Field(default_factory=list, description="per-project venues")
    deadline: str = Field("", description="ISO date the user wants to hand off by")
    rounds_done: int = 0
    created: str = Field(default_factory=now_iso)
    updated: str = Field(default_factory=now_iso)
    priority_since: str = Field(default_factory=now_iso)


# ---------------------------------------------------------------------------
# Feed + compost (sections 3, 4)
# ---------------------------------------------------------------------------


class FeedItem(Model):
    id: str
    source_id: str = ""
    source_kind: str = Field("manual", description="the FeedSource kind, or manual for saved links")
    source_name: str = ""
    external_id: str = ""
    url: str = ""
    title: str
    author: str = ""
    published: str = ""
    content: str = Field("", description="raw text excerpt used for summarizing")
    summary: str = ""
    tags: list[str] = Field(default_factory=list)
    technologies: list[str] = Field(default_factory=list)
    relevance: float = Field(0.0, ge=0, le=1, description="model relevance before preference blending")
    score: float = Field(0.0, ge=0, le=1, description="final ranking score")
    why: str = Field("", description="one line: why this matters to you")
    related_seed_ids: list[str] = Field(default_factory=list)
    status: FeedStatus = FeedStatus.new
    viewed_at: str = Field("", description="when the user first opened this item; empty = not viewed")
    created: str = Field(default_factory=now_iso)


class Attachment(Model):
    """A file the user attached to a chat; its extracted text is what the models read."""

    id: str
    name: str
    mime: str = ""
    size: int = 0
    path: str = ""
    text: str = Field("", description="extracted text")
    created: str = Field(default_factory=now_iso)


class CompostItem(Model):
    id: str
    title: str
    links: list[str] = Field(default_factory=list)
    source: str = ""
    date: str = ""
    summary: str = ""
    takeaways: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    technologies: list[str] = Field(default_factory=list)
    related_seed_ids: list[str] = Field(default_factory=list)
    why_interesting: str = ""
    notes: str = ""
    origin: Literal["feed", "manual", "seed"] = "manual"
    feed_item_id: str = ""
    seed_id: str = ""
    cluster: str = ""
    processed: bool = False
    created: str = Field(default_factory=now_iso)
    updated: str = Field(default_factory=now_iso)


class FeedSource(Model):
    id: str
    kind: Literal["rss", "youtube", "arxiv", "alphaxiv", "hf_papers", "hf_hub", "github", "email", "hn", "reddit",
                  "lobsters", "bluesky", "mastodon", "folder", "twitter", "hackster", "medium", "biorxiv", "conference"]
    name: str
    config: dict[str, Any] = Field(
        default_factory=dict,
        description="rss/youtube: url|channel_id; arxiv: category|query; github: mode (new|popular|releases), "
                    "topic|repo; hf_hub: repo_type (models|datasets|spaces), mode (popular|new), query; "
                    "email: folder|path; hn: query; reddit: subreddit; lobsters: tag; bluesky: handle; "
                    "mastodon: account; folder: path; twitter: handle|query, rss_url; medium: mode (tag|author|"
                    "publication), name; biorxiv: server (biorxiv|medrxiv), subject; conference: venue",
    )
    enabled: bool = True
    interval_hours: float = Field(6, gt=0)
    last_fetched: str = ""
    last_error: str = ""


# ---------------------------------------------------------------------------
# Exploration graph (section 6)
# ---------------------------------------------------------------------------


class Scores(Model):
    novelty: float = Field(0.5, ge=0, le=1, description="1 = nothing like it exists")
    feasibility: float = Field(0.5, ge=0, le=1, description="1 = easily doable under the user's constraints")
    crowdedness: float = Field(0.5, ge=0, le=1, description="1 = very crowded area")
    interest: float = Field(0.5, ge=0, le=1, description="1 = squarely what the user cares about")
    overall: float = Field(0.5, ge=0, le=1)


class ExplorationNode(Model):
    id: str
    seed_id: str
    round: int = 0
    kind: NodeKind
    status: NodeStatus = NodeStatus.active
    title: str
    summary: str = ""
    url: str = ""
    score: float | None = None
    reason: str = Field("", description="why pruned / why selected")
    parents: list[str] = Field(default_factory=list, description="ids of nodes this one grew from")
    data: dict[str, Any] = Field(default_factory=dict)
    created: str = Field(default_factory=now_iso)


class Evidence(Model):
    """A pointer to a source node or a smoke-check result inside the seed's graph."""

    ref: str = Field(..., description="exploration node id (source / smoke / check)")
    quote: str = Field("", description="short supporting quote or fact from that source")


class Finding(Model):
    text: str
    evidence: list[Evidence] = Field(default_factory=list, min_length=1)


class FlowerDirection(Model):
    title: str
    node_id: str = Field("", description="the direction node this recommends")
    pitch: str = Field(..., description="2-3 sentences: what to do and why it is promising")
    why_you: str = Field("", description="why it fits this user's skills, compute and interests")


class ClosestWork(Model):
    ref: str = Field(..., description="source node id")
    title: str = ""
    how_it_differs: str


class Novelty(Model):
    closest_work: list[ClosestWork] = Field(default_factory=list)
    gap: str = ""


class Flower(Model):
    schema_version: str = SCHEMA_VERSION
    seed_id: str
    version: int = 1
    round: int = 1
    idea: str = Field(..., description="the idea in one paragraph")
    findings: list[Finding] = Field(..., min_length=1, max_length=7)
    directions: list[FlowerDirection] = Field(..., min_length=1, max_length=3)
    novelty: Novelty = Field(default_factory=Novelty)
    risks: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    first_steps: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)
    stability: float = Field(0.0, ge=0, le=1, description="similarity to the previous version")
    visuals: list[str] = Field(default_factory=list, description="visual ids")
    updated: str = Field(default_factory=now_iso)


class SmokeCheck(Model):
    id: str
    seed_id: str
    direction_id: str = ""
    assumption: str
    rationale: str = ""
    code: str
    expected: str = ""
    timeout_s: int = Field(60, ge=1, le=300)
    status: Literal["pending", "approved", "running", "passed", "failed", "rejected", "error"] = "pending"
    stdout: str = ""
    stderr: str = ""
    metrics: dict[str, float] = Field(default_factory=dict)
    verdict: str = ""
    created: str = Field(default_factory=now_iso)
    finished: str = ""


class Visual(Model):
    id: str
    seed_id: str
    kind: Literal["concept", "landscape", "scores", "smoke", "graph"]
    title: str
    caption: str = ""
    files: dict[str, str] = Field(default_factory=dict, description="format -> path relative to the seed visuals dir")
    round: int = 0
    created: str = Field(default_factory=now_iso)


# ---------------------------------------------------------------------------
# Flower pack (section 7)
# ---------------------------------------------------------------------------


class Milestone(Model):
    title: str
    goal: str = ""
    tasks: list[str] = Field(default_factory=list)
    est_hours: float | None = None


class Handoff(Model):
    objective: str
    metric: str = Field(..., description="what number says it worked, and which direction is better")
    metric_direction: Literal["maximize", "minimize", "qualitative"] = "maximize"
    baseline: str = ""
    may_change: list[str] = Field(default_factory=list)
    must_not_change: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    background: str = ""
    preferences: list[str] = Field(default_factory=list)
    milestones: list[Milestone] = Field(default_factory=list)
    first_session: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    conventions: list[str] = Field(default_factory=list)
    first_experiments: list[str] = Field(default_factory=list)


class PackSource(Model):
    id: str
    title: str
    url: str = ""
    kind: str = ""
    year: int | None = None
    summary: str = ""
    tool: str = ""


class PrunedBranch(Model):
    id: str
    title: str
    summary: str = ""
    reason: str
    round: int = 0
    scores: Scores | None = None


class FlowerPack(Model):
    schema_version: str = SCHEMA_VERSION
    florist_version: str = ""
    slug: str
    seed: Seed
    constraints_snapshot: dict[str, Any] = Field(default_factory=dict)
    flower: Flower
    handoff: Handoff
    directions: list[ExplorationNode] = Field(default_factory=list)
    sources: list[PackSource] = Field(default_factory=list)
    pruned: list[PrunedBranch] = Field(default_factory=list)
    visuals: list[Visual] = Field(default_factory=list)
    smoke: list[SmokeCheck] = Field(default_factory=list)
    adapters: list[str] = Field(default_factory=list)
    cost: dict[str, float] = Field(default_factory=dict)
    generated_at: str = Field(default_factory=now_iso)


# ---------------------------------------------------------------------------
# Step outputs (what each skill returns)
# ---------------------------------------------------------------------------


class SearchQuery(Model):
    query: str = Field(..., min_length=2)
    kind: Literal["paper", "repo", "post", "any"] = "paper"
    why: str = ""


class GroundPlan(Model):
    queries: list[SearchQuery] = Field(..., min_length=1, max_length=12)
    technologies: list[str] = Field(default_factory=list, description="key technologies to map")


class SourceNote(Model):
    ref: str = Field(..., description="source node id being judged")
    keep: bool = True
    relevance: float = Field(0.5, ge=0, le=1)
    summary: str = Field("", description="one or two sentences, in terms of the seed")
    technologies: list[str] = Field(default_factory=list)


class GroundTriage(Model):
    notes: list[SourceNote] = Field(..., min_length=1)
    landscape: str = Field("", description="3-5 sentences: what exists, what is crowded, where gaps might be")


class ProposedDirection(Model):
    title: str = Field(..., min_length=3)
    description: str = Field(..., description="what would be built or studied, 2-4 sentences")
    framing: str = Field("", description="the angle that makes it distinct")
    technologies: list[str] = Field(default_factory=list)
    scope: str = Field("", description="what is in and out for a first version")
    evolves: str = Field("", description="id of an existing direction this evolves/deepens, if any")
    inspired_by: list[str] = Field(default_factory=list, description="source node ids")


class ExploreOutput(Model):
    directions: list[ProposedDirection] = Field(..., min_length=1, max_length=8)


class DirectionCheck(Model):
    ref: str = Field(..., description="direction node id")
    novelty: float = Field(..., ge=0, le=1)
    feasibility: float = Field(..., ge=0, le=1)
    crowdedness: float = Field(..., ge=0, le=1)
    interest: float = Field(..., ge=0, le=1)
    closest_work: list[ClosestWork] = Field(default_factory=list)
    gap: str = Field("", description="what is genuinely not done yet; empty if nothing")
    feasibility_notes: str = ""
    risks: list[str] = Field(default_factory=list)
    smoke_worthy: str = Field("", description="a key assumption a tiny test could confirm, if any")


class CheckOutput(Model):
    checks: list[DirectionCheck] = Field(..., min_length=1)


class SmokeProposal(Model):
    direction_ref: str = ""
    assumption: str
    rationale: str = ""
    code: str = Field(..., description="self-contained Python, stdlib preferred, prints SMOKE_RESULT {json}")
    expected: str = ""
    timeout_s: int = Field(60, ge=5, le=300)


class SmokeOutput(Model):
    proposals: list[SmokeProposal] = Field(default_factory=list, max_length=2)


class ConceptStep(Model):
    id: str = Field(..., pattern=r"^[A-Za-z][A-Za-z0-9_]{0,24}$")
    label: str = Field(..., max_length=48)
    detail: str = Field("", max_length=160)
    group: str = Field("", description="optional lane: input / model / output / data ...")


class ConceptEdge(Model):
    source: str
    target: str
    label: str = Field("", max_length=32)


class ConceptSpec(Model):
    title: str
    key_insight: str = Field(..., description="one sentence: the core idea of the technique")
    steps: list[ConceptStep] = Field(..., min_length=2, max_length=10)
    edges: list[ConceptEdge] = Field(default_factory=list)
    caption: str = ""


class RankedDirection(Model):
    ref: str
    rank: int = Field(..., ge=1)
    keep: bool
    reason: str = Field(..., description="why kept, or why pruned (kept with the pruned branch)")
    deepen: str = Field("", description="for kept directions: what to dig into next round")


class ExploitOutput(Model):
    ranking: list[RankedDirection] = Field(..., min_length=1)


class FlowerDraft(Model):
    idea: str
    findings: list[Finding] = Field(..., min_length=1, max_length=7)
    directions: list[FlowerDirection] = Field(..., min_length=1, max_length=3)
    novelty: Novelty = Field(default_factory=Novelty)
    risks: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    first_steps: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)


class FollowUpQuestions(Model):
    questions: list[str] = Field(default_factory=list, max_length=2)
    title: str = Field("", description="short title for the seed if the user gave none")
    technologies: list[str] = Field(default_factory=list)
    tier_suggestion: Tier | None = None


class FeedTriageItem(Model):
    ref: str = Field(..., description="feed item id")
    summary: str
    tags: list[str] = Field(default_factory=list, max_length=6)
    technologies: list[str] = Field(default_factory=list, max_length=6)
    relevance: float = Field(..., ge=0, le=1)
    why: str = Field(..., description="one line: why this matters to the user, naming the seed or interest")
    related_seed_ids: list[str] = Field(default_factory=list)


class FeedTriage(Model):
    items: list[FeedTriageItem]


class CompostProcessed(Model):
    summary: str
    takeaways: list[str] = Field(default_factory=list, max_length=5)
    tags: list[str] = Field(default_factory=list, max_length=8)
    technologies: list[str] = Field(default_factory=list, max_length=8)
    why_interesting: str = ""
    related_seed_ids: list[str] = Field(default_factory=list)


class MinedSeed(Model):
    title: str
    prompt: str
    tier: Tier = Tier.exploration
    compost_ids: list[str] = Field(..., min_length=2, description="the compost items this connects")
    connection: str = Field(..., description="what these items share and why it matters to the user")
    technologies: list[str] = Field(default_factory=list)


class MiningOutput(Model):
    candidates: list[MinedSeed] = Field(default_factory=list, max_length=5)


class ClusterLabels(Model):
    labels: dict[str, str] = Field(default_factory=dict, description="cluster id -> short theme label")


class LearnedStatement(Model):
    statement: str = Field(..., description="a plain-language preference, e.g. 'prefers hands-on repos to surveys'")
    weight: float = Field(..., ge=-1, le=1)
    evidence: int = Field(1, ge=1)


class PreferenceDistill(Model):
    statements: list[LearnedStatement] = Field(default_factory=list, max_length=8)


class ChatAction(Model):
    type: Literal["steer", "prune", "boost", "deepen", "add_constraint", "set_tier", "run_round", "none"]
    target: str = Field("", description="node id for prune/boost/deepen; constraint text; tier name")
    note: str = ""


class ChatReply(Model):
    reply: str
    actions: list[ChatAction] = Field(default_factory=list)


class IdeateReply(Model):
    reply: str = Field(..., description="markdown answer")
    suggest_seed: bool = Field(False, description="true when the conversation has converged on a seedable idea")
    seed_title: str = ""


class SkillReport(Model):
    reply: str = Field(..., description="markdown report for the chat")


class NoveltyReport(Model):
    novelty: float = Field(..., ge=0, le=1)
    crowdedness: float = Field(..., ge=0, le=1)
    gap: str = Field("", description="what is genuinely not done yet; empty if nothing")
    reply: str = Field(..., description="markdown: closest work, how the idea differs, and what to do about it")


class SuggestedSource(Model):
    kind: Literal["arxiv", "biorxiv", "conference", "github", "hf_hub", "reddit", "hn", "lobsters", "medium",
                  "youtube", "bluesky", "mastodon", "twitter", "rss"]
    name: str = Field(..., description="short display name")
    target: str = Field(..., description="what to follow; its meaning depends on kind (see the skill)")
    why: str = Field("", description="one line: why this suits the user")


class SourceSuggestions(Model):
    reply: str = Field(..., description="one or two sentences introducing the suggestions")
    sources: list[SuggestedSource] = Field(default_factory=list, max_length=8)


class FeedIdea(Model):
    title: str
    prompt: str = Field(..., description="the idea, 2-4 sentences")
    tier: Tier = Tier.exploration
    feed_ids: list[str] = Field(..., min_length=1, description="the feed items that inspired it")
    connection: str = Field(..., description="what these items suggest together and why it suits the user")
    technologies: list[str] = Field(default_factory=list)


class FeedIdeas(Model):
    candidates: list[FeedIdea] = Field(default_factory=list, max_length=5)


class PolishReport(Model):
    stage: Literal["spark", "shaped", "scoped", "grounded", "ready"]
    why: str = Field(..., description="one sentence: why the idea is at this stage")
    reply: str = Field(..., description="markdown: the idea shored up for this stage")


class SeedFromChat(Model):
    title: str = Field(..., max_length=80)
    prompt: str = Field(..., description="2-5 sentences: the idea as it now stands, in the user's terms")
    tier: Tier = Tier.personal
    technologies: list[str] = Field(default_factory=list)
    must_use: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)


class ProfileSync(Model):
    interests: list[str] = Field(default_factory=list)
    proficient_in: list[str] = Field(default_factory=list)
    wants_to_learn: list[str] = Field(default_factory=list)
    compute: str = ""
    budget_usd_month: float | None = None
    hours_per_week: float | None = None
    goal_date: str = ""
    conference_targets: list[str] = Field(default_factory=list)
    work_preferences: list[str] = Field(default_factory=list)


class HandoffPlan(Handoff):
    """Pick step output — the handoff block of a flower pack."""


STEP_OUTPUTS: dict[str, type[Model]] = {
    "ground": GroundPlan,
    "triage": GroundTriage,
    "explore": ExploreOutput,
    "check": CheckOutput,
    "smoke": SmokeOutput,
    "visualize": ConceptSpec,
    "exploit": ExploitOutput,
    "flower": FlowerDraft,
    "pick": HandoffPlan,
    "followups": FollowUpQuestions,
    "feed_triage": FeedTriage,
    "compost": CompostProcessed,
    "mining": MiningOutput,
    "clusters": ClusterLabels,
    "taste": PreferenceDistill,
    "chat": ChatReply,
    "ideate": IdeateReply,
    "seed_from_chat": SeedFromChat,
    "profile_sync": ProfileSync,
    "literature_plan": GroundPlan,
    "literature_review": SkillReport,
    "novelty": NoveltyReport,
    "find_sources": SourceSuggestions,
    "feed_ideas": FeedIdeas,
    "polish": PolishReport,
}

RECORDS: dict[str, type[Model]] = {
    "Seed": Seed,
    "FeedItem": FeedItem,
    "FeedSource": FeedSource,
    "Attachment": Attachment,
    "CompostItem": CompostItem,
    "ExplorationNode": ExplorationNode,
    "Flower": Flower,
    "FlowerPack": FlowerPack,
    "Profile": Profile,
    "SmokeCheck": SmokeCheck,
    "Visual": Visual,
}


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))

