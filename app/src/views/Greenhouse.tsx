import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Flower2, MessageCircle, Moon, Plus, Search, Settings2, Sprout } from "lucide-react";
import { api, relTime, Seed, Tier } from "../api";
import { go } from "../App";
import Mascot from "../components/character/Mascot";
import { FilterButton, FilterGroup, FilterModal, FilterPill } from "../components/Filters";
import { Page, PageTitle } from "../components/Layout";
import { TIER_HINT, TIERS } from "../components/SeedTypeDialog";
import { Button, ChipInput, cx, Field, Modal, TIER_LABEL, TierBadge, toast } from "../components/ui";
import { StagePill } from "./Ideate";

const STAGES = [{ id: "all", label: "All" }, { id: "seed", label: "Seed" }, { id: "growing", label: "Growing" }, { id: "flower", label: "Flower" }, { id: "picked", label: "Picked" }];
const STAGE_BAR: Record<string, string> = { seed: "bg-border", growing: "bg-blue", flower: "bg-leaf" };

export default function GreenhouseView({ openNew }: { openNew?: boolean }) {
  const qc = useQueryClient();
  const seeds = useQuery({ queryKey: ["seeds", "all"], queryFn: () => api.get<Seed[]>("/api/seeds?all=true") });
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("all");
  const [tier, setTier] = useState("all");
  const [filtering, setFiltering] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [planting, setPlanting] = useState(!!openNew);
  useEffect(() => { if (openNew) setPlanting(true); }, [openNew]);
  const decide = useMutation({
    mutationFn: (v: { id: string; d: "accept" | "reject" }) => api.post(`/api/candidates/${v.id}/${v.d}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seeds"] }),
  });

  const all = seeds.data ?? [];
  const candidates = all.filter((s) => s.state === "candidate");
  const list = useMemo(() => all.filter((s) => s.state !== "candidate" && s.state !== "composted")
    .filter((s) => stage === "all" || (stage === "picked" ? s.state === "picked" : s.stage?.stage === stage && s.state !== "picked"))
    .filter((s) => tier === "all" || s.tier === tier)
    .filter((s) => !q || `${s.title} ${s.prompt} ${s.technologies.join(" ")}`.toLowerCase().includes(q.toLowerCase())), [all, q, stage, tier]);
  const selected = all.find((s) => s.id === sel) ?? null;

  return (
    <Page
      header={<>
        <PageTitle sub={`${list.length} seeds`}>Seeds</PageTitle>
        <div className="ml-auto"><Button kind="primary" size="sm" onClick={() => setPlanting(true)}><Plus size={13} />New seed</Button></div>
      </>}
      inspector={selected ? <QuickSettings seed={selected} key={selected.id + selected.updated} /> : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13.5px] text-muted">
          <Mascot mood="idle" size={80} />Select a seed for quick settings
        </div>
      )}>
      <div className="mx-auto max-w-[920px] px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search seeds" className="h-8 w-full pl-8 text-[14px]" />
          </div>
          <FilterButton active={(stage !== "all" ? 1 : 0) + (tier !== "all" ? 1 : 0)} onClick={() => setFiltering(true)} />
        </div>

        {candidates.length > 0 && (
          <div className="mb-4 rounded-xl border border-leaf/30 bg-leaf-soft/30 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-leaf-ink"><Sprout size={13} />Proposed ideas</div>
            {candidates.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-1 text-[14px]">
                <span className="min-w-0 flex-1 truncate" title={c.prompt}>{c.title}</span>
                <Button size="sm" kind="primary" onClick={() => decide.mutate({ id: c.id, d: "accept" })}><Check size={12} />Plant</Button>
                <Button size="sm" kind="ghost" onClick={() => decide.mutate({ id: c.id, d: "reject" })}>Ignore</Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {list.map((s) => (
            <div key={s.id} onClick={() => setSel(s.id)}
              className={cx("rise flex cursor-pointer overflow-hidden rounded-xl border bg-base transition", sel === s.id ? "border-leaf shadow-card" : "border-border-soft hover:border-border")}>
              <div className={cx("w-1.5 shrink-0", s.state === "picked" ? "bg-purple" : STAGE_BAR[s.stage?.stage ?? "seed"])} />
              <div className="min-w-0 flex-1 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-semibold">{s.title}</span>
                  {s.state === "picked" ? <span className="rounded-full bg-purple-soft px-2 py-[1px] text-[12px] font-medium text-purple">Picked</span> : <StagePill stage={s.stage?.stage ?? "seed"} />}
                  <TierBadge tier={s.tier} />
                  {s.run?.status === "running" && <span className="pulse-leaf text-[12px] text-leaf-ink">growing…</span>}
                </div>
                <div className="mt-0.5 line-clamp-1 text-[13.5px] text-subtext">{s.flower?.directions[0] ?? s.prompt}</div>
                <div className="mt-1.5 flex items-center gap-3 text-[12.5px] text-muted">
                  <Priority value={s.priority} />
                  <span>{s.rounds_done} rounds</span>
                  <span><FileText size={10} className="mr-0.5 inline" />{s.counts?.source ?? 0}</span>
                  <span>${s.usd.toFixed(2)}</span>
                  {s.passive && <span className="text-purple"><Moon size={10} className="inline" /> passive</span>}
                  {s.pending_smoke > 0 && <span className="rounded-full bg-amber-soft px-1.5 text-amber">{s.pending_smoke} to approve</span>}
                  <span className="ml-auto">{relTime(s.updated)}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col justify-center gap-1 pr-3">
                <button title="Open chat" onClick={(e) => { e.stopPropagation(); go(`/seed/${s.id}`); }} className="rounded-md p-1.5 text-subtext hover:bg-leaf-soft hover:text-leaf-ink"><MessageCircle size={15} /></button>
                <button title="Seed page" onClick={(e) => { e.stopPropagation(); go(`/greenhouse/${s.id}`); }} className="rounded-md p-1.5 text-subtext hover:bg-hover"><Settings2 size={15} /></button>
              </div>
            </div>
          ))}
          {seeds.isSuccess && !list.length && (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-[14px] text-subtext">
              <Mascot mood="wave" size={96} />
              {all.length ? "No seeds match." : "Plant your first seed — or start in Ideate and turn a chat into one."}
            </div>
          )}
        </div>
      </div>
      <PlantDialog open={planting} onClose={() => { setPlanting(false); if (openNew) go("/greenhouse"); }} />
      <FilterModal open={filtering} onClose={() => setFiltering(false)} onReset={() => { setStage("all"); setTier("all"); }} width={480}>
        <FilterGroup title="Stage">{STAGES.map((s) => <FilterPill key={s.id} on={stage === s.id} onClick={() => setStage(s.id)}>{s.label}</FilterPill>)}</FilterGroup>
        <FilterGroup title="Type">
          <FilterPill on={tier === "all"} onClick={() => setTier("all")}>All</FilterPill>
          {TIERS.map((t) => <FilterPill key={t} on={tier === t} onClick={() => setTier(t)}>{TIER_LABEL[t]}</FilterPill>)}
        </FilterGroup>
      </FilterModal>
    </Page>
  );
}

export function Priority({ value }: { value: number }) {
  return <span title={`Priority ${value}/5`} className="flex gap-[2px]">{[1, 2, 3, 4, 5].map((i) => <span key={i} className={cx("h-1.5 w-1.5 rounded-full", i <= value ? "bg-leaf" : "bg-border")} />)}</span>;
}

function QuickSettings({ seed }: { seed: Seed }) {
  const qc = useQueryClient();
  const [d, setD] = useState({ title: seed.title, priority: seed.priority, tier: seed.tier, passive: seed.passive, max_rounds: seed.budget.max_rounds, max_usd: seed.budget.max_usd });
  const dirty = d.title !== seed.title || d.priority !== seed.priority || d.tier !== seed.tier || d.passive !== seed.passive
    || d.max_rounds !== seed.budget.max_rounds || d.max_usd !== seed.budget.max_usd;
  const save = useMutation({
    mutationFn: () => api.patch(`/api/seeds/${seed.id}`, { title: d.title, priority: d.priority, tier: d.tier, passive: d.passive, budget: { max_rounds: d.max_rounds, max_usd: d.max_usd } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["seeds"] }); toast("Saved"); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-subtext">Selected seed</div>
        <Field label="Name"><input className="w-full" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
        <Field label={`Priority · ${d.priority}`}>
          <input type="range" min={1} max={5} value={d.priority} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} className="w-full" />
        </Field>
        <Field label="Tier">
          <div className="flex flex-col gap-1">
            {TIERS.map((t) => (
              <button key={t} onClick={() => setD({ ...d, tier: t })} className={cx("rounded-md border px-2.5 py-1.5 text-left text-[13.5px]", d.tier === t ? "border-leaf bg-leaf-soft/50" : "border-border-soft hover:bg-hover")}>{TIER_LABEL[t]}</button>
            ))}
          </div>
        </Field>
        <Field label={`Budget · ${d.max_rounds} rounds, $${d.max_usd}`}>
          <div className="flex items-center gap-2">
            <input type="range" min={1} max={10} value={d.max_rounds} onChange={(e) => setD({ ...d, max_rounds: Number(e.target.value) })} className="flex-1" />
            <select value={d.max_usd} onChange={(e) => setD({ ...d, max_usd: Number(e.target.value) })} className="h-7 px-1.5 py-0 text-[13px]">
              {[0.5, 1, 2, 5, 10, 25].map((v) => <option key={v} value={v}>${v}</option>)}
            </select>
          </div>
        </Field>
        <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={d.passive} onChange={(e) => setD({ ...d, passive: e.target.checked })} className="accent-[var(--leaf)]" />Grow in the background</label>
        <div className="mt-5 flex flex-col gap-1.5">
          <Button size="sm" onClick={() => go(`/seed/${seed.id}`)}><MessageCircle size={12} />Open chat</Button>
          <Button size="sm" onClick={() => go(`/greenhouse/${seed.id}`)}><Settings2 size={12} />Seed page</Button>
          {seed.flower && <Button size="sm" onClick={() => go(`/seed/${seed.id}/flower`)}><Flower2 size={12} />View flower</Button>}
        </div>
      </div>
      <div className="border-t border-border-soft p-3">
        <Button kind="primary" className="w-full" disabled={!dirty} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </div>
  );
}

export function PlantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ prompt: "", tier: "personal" as Tier, technologies: [] as string[], priority: 3 });
  const [qs, setQs] = useState<{ id: string; qs: string[]; answers: string[] } | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ seed: Seed; questions: string[] }>("/api/seeds", { ...v, ask_followups: true }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["seeds"] });
      if (r.questions.length) setQs({ id: r.seed.id, qs: r.questions, answers: r.questions.map(() => "") });
      else finish(r.seed.id);
    },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const finish = (id: string) => { setV({ prompt: "", tier: "personal", technologies: [], priority: 3 }); setQs(null); onClose(); go(`/greenhouse/${id}`); };
  if (qs) {
    return (
      <Modal open={open} onClose={() => finish(qs.id)} title="A couple of questions"
        footer={<><Button onClick={() => finish(qs.id)}>Skip</Button><Button kind="primary" onClick={() => api.post(`/api/seeds/${qs.id}/followups`, { answers: qs.answers }).then(() => finish(qs.id))}>Save</Button></>}>
        {qs.qs.map((q, i) => (
          <Field key={i} label={q}><textarea rows={2} className="w-full" value={qs.answers[i]} onChange={(e) => setQs({ ...qs, answers: qs.answers.map((a, j) => (j === i ? e.target.value : a)) })} /></Field>
        ))}
      </Modal>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={<span className="flex items-center gap-2"><Sprout size={16} className="text-leaf" />New seed</span>} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={create.isPending} disabled={v.prompt.trim().length < 8} onClick={() => create.mutate()}>Plant</Button></>}>
      <textarea autoFocus rows={4} className="mb-3 w-full text-[15px]" value={v.prompt} onChange={(e) => setV({ ...v, prompt: e.target.value })}
        placeholder="What's the idea? A sentence is enough — the spec sheet holds the details." />
      <div className="mb-3 grid grid-cols-3 gap-2">
        {TIERS.map((t) => (
          <button key={t} onClick={() => setV({ ...v, tier: t })} className={cx("rounded-lg border p-2 text-left", v.tier === t ? "border-leaf bg-leaf-soft/50" : "border-border-soft hover:border-border")}>
            <TierBadge tier={t} /><div className="mt-1 text-[12.5px] text-subtext">{TIER_HINT[t]}</div>
          </button>
        ))}
      </div>
      <Field label="Technologies (optional)"><ChipInput value={v.technologies} onChange={(t) => setV({ ...v, technologies: t })} placeholder="PyTorch, llama.cpp…" /></Field>
      <Field label={`Priority · ${v.priority}`}><input type="range" min={1} max={5} value={v.priority} onChange={(e) => setV({ ...v, priority: Number(e.target.value) })} className="w-full" /></Field>
    </Modal>
  );
}
