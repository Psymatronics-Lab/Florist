import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export type Tier = "exploration" | "personal" | "formal";
export type SeedState = "candidate" | "dormant" | "growing" | "flowering" | "picked" | "composted";

export interface Seed {
  id: string; slug: string; title: string; prompt: string; tier: Tier; state: SeedState; priority: number;
  technologies: string[]; related_papers: string[]; compost_ids: string[]; feed_ids: string[];
  constraints: { time: string; compute: string; skills: string; must_use: string[]; must_avoid: string[]; notes: string };
  followups: { question: string; answer: string }[]; passive: boolean;
  budget: { max_rounds: number; max_usd: number }; origin: string; rounds_done: number; created: string; updated: string;
  flower: { version: number; stability: number; idea: string; directions: string[] } | null;
  run: { id: string; status: string; step: string; round: number; mode: string } | null;
  usd: number; pending_smoke: number;
  conference_targets: string[]; deadline: string;
  stage?: { stage: "seed" | "growing" | "flower"; why: string };
  counts?: Record<string, number>;
}

export interface CtxItem { kind: "compost" | "feed" | "source" | "seed" | "file"; id: string; title?: string }
export interface ChatMsg { id: number; role: string; content: string; actions: any[]; created: string }
export interface IdeateChat { id: string; title: string; seed_id: string; context: CtxItem[]; created: string; updated: string; messages?: ChatMsg[] }
export interface Provider {
  id: string; name: string; kind: "subscription" | "api" | "local" | "offline"; logo: string; models: string[];
  configured: boolean; detail: string; setup?: string[]; note?: string; keys_url?: string; key_env?: string;
}
export interface SeedFiles {
  papers: { id: string; title: string; url: string; kind: string; tool: string; year?: number; pdf: string }[];
  repos: { id: string; title: string; url: string; stars?: number }[];
  experiments: { id: string; assumption: string; status: string; verdict: string }[];
  artifacts: { id: string; title: string; kind: string; files: Record<string, string> }[];
  packs: { seed_id: string; path: string; created: string }[];
  context: { kind: string; id: string; title: string; summary?: string }[];
}

export interface GraphNode {
  id: string; seed_id: string; round: number; kind: string; status: "active" | "top" | "pruned"; title: string;
  summary: string; url: string; score: number | null; reason: string; parents: string[]; data: Record<string, any>;
}
export interface Graph { nodes: GraphNode[]; edges: { src: string; dst: string; kind: string }[]; mermaid: string }

export interface Evidence { ref: string; quote: string }
export interface Flower {
  version: number; round: number; idea: string; stability: number; updated: string;
  findings: { text: string; evidence: Evidence[] }[];
  directions: { title: string; node_id: string; pitch: string; why_you: string }[];
  novelty: { closest_work: { ref: string; title: string; how_it_differs: string }[]; gap: string };
  risks: string[]; open_questions: string[]; first_steps: string[]; success_criteria: string[];
}
export interface FlowerResp {
  flower: Flower | null;
  refs: Record<string, { title: string; url?: string; kind: string; year?: number; summary?: string }>;
  versions: { version: number; round: number; stability: number; updated: string }[];
}
export interface Visual { id: string; seed_id: string; kind: string; title: string; caption: string; files: Record<string, string>; round: number }
export interface Smoke {
  id: string; seed_id: string; direction_id: string; assumption: string; rationale: string; code: string; expected: string;
  timeout_s: number; status: string; stdout: string; stderr: string; metrics: Record<string, number>; verdict: string; created: string;
}
export interface FeedItem {
  id: string; source_id: string; source_kind: string; source_name: string; url: string; title: string; author: string; published: string;
  content: string; summary: string; tags: string[]; technologies: string[]; relevance: number; score: number; why: string;
  related_seed_ids: string[]; status: string; created: string; viewed_at: string;
}
export interface CompostItem {
  id: string; title: string; links: string[]; source: string; date: string; summary: string; takeaways: string[];
  tags: string[]; technologies: string[]; related_seed_ids: string[]; why_interesting: string; notes: string;
  origin: string; cluster: string; processed: boolean; created: string;
}
export interface Cluster { id: string; label: string; terms: string[]; items: string[]; titles: string[] }
export interface LearnedPref { id: string; kind: string; key: string; weight: number; evidence: number; locked: boolean; note: string; updated: string }
export interface Profile {
  name: string; interests: string[]; proficient_in: string[]; wants_to_learn: string[];
  resources: { compute: string; budget_usd_month: number; notes: string };
  time: { hours_per_week: number; goal_date: string; goal_label: string };
  conference_targets: string[]; work_preferences: string[];
  downtime: { mode: "run" | "scheduled" | "stop"; enabled: boolean; windows: { days: string[]; start: string; end: string }[]; max_usd_per_window: number; subscription_fraction: number };
  compost_after_days: number; feed_fold_threshold: number; learned_preferences: LearnedPref[];
}
export interface Activity { id: number; created: string; kind: string; seed_id: string; message: string; data: Record<string, any> }
export interface Source { id: string; kind: string; name: string; config: Record<string, any>; enabled: boolean; interval_hours: number; last_fetched: string; last_error: string }

export class ApiError extends Error {}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).detail ?? msg; } catch { /* not JSON */ }
    throw new ApiError(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  get: <T,>(url: string) => req<T>("GET", url),
  post: <T,>(url: string, body: unknown = {}) => req<T>("POST", url, body),
  put: <T,>(url: string, body: unknown) => req<T>("PUT", url, body),
  patch: <T,>(url: string, body: unknown) => req<T>("PATCH", url, body),
  del: <T,>(url: string) => req<T>("DELETE", url),
};

export const visualUrl = (seedId: string, file: string) => `/api/visuals/${seedId}/${encodeURIComponent(file)}`;

/** Live activity over /ws: invalidates queries as work happens anywhere (UI, CLI, MCP, agents). */
export function useLiveActivity(): Activity[] {
  const qc = useQueryClient();
  const [items, setItems] = useState<Activity[]>([]);
  const retry = useRef(0);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: number | undefined;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retry.current = 0; };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type !== "activity") return;
        const rows: Activity[] = msg.items;
        setItems((prev) => [...prev, ...rows].slice(-300));
        const kinds = new Set(rows.map((r) => r.kind));
        const seeds = new Set(rows.map((r) => r.seed_id).filter(Boolean));
        qc.invalidateQueries({ queryKey: ["seeds"] });
        qc.invalidateQueries({ queryKey: ["status"] });
        seeds.forEach((s) => qc.invalidateQueries({ queryKey: ["seed", s] }));
        if (kinds.has("feed")) qc.invalidateQueries({ queryKey: ["feed"] });
        if (kinds.has("compost") || kinds.has("mining")) qc.invalidateQueries({ queryKey: ["compost"] });
        if (kinds.has("taste") || kinds.has("steer")) qc.invalidateQueries({ queryKey: ["profile"] });
      };
      ws.onclose = () => {
        if (closed) return;
        retry.current = Math.min(retry.current + 1, 6);
        timer = window.setTimeout(connect, 500 * 2 ** retry.current);
      };
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); ws?.close(); };
  }, [qc]);
  return items;
}

export function relTime(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso.length <= 10 ? iso + "T00:00:00Z" : iso).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return iso.slice(0, 10);
}
