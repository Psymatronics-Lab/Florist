import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, FileText, FlaskConical, Flower2, GitFork, Image as ImageIcon, MessageCircle, Package, Recycle, Trash2 } from "lucide-react";
import { api, Seed, SeedFiles } from "../api";
import { go } from "../App";
import Heatmap from "../components/Heatmap";
import { Page, PageTitle } from "../components/Layout";
import MarkdownDoc from "../components/MarkdownDoc";
import PickDialog from "../components/PickDialog";
import { Button, Chip, cx, Section, Spinner, TIER_LABEL, toast } from "../components/ui";
import { Priority } from "./Greenhouse";

const STAGES = [
  { id: "seed", label: "Seed", hint: "planted, not explored yet" },
  { id: "growing", label: "Growing", hint: "rounds running, flower still changing" },
  { id: "flower", label: "Flower", hint: "findings stable, ready to pick" },
];

export default function SeedConfig({ id }: { id: string }) {
  const qc = useQueryClient();
  const seed = useQuery({ queryKey: ["seed", id], queryFn: () => api.get<Seed>(`/api/seeds/${id}`) });
  const sid = seed.data?.id ?? id;
  const spec = useQuery({ queryKey: ["seed", sid, "spec"], queryFn: () => api.get<{ text: string; path: string }>(`/api/seeds/${sid}/spec`) });
  const files = useQuery({ queryKey: ["seed", sid, "files"], queryFn: () => api.get<SeedFiles>(`/api/seeds/${sid}/files`) });
  const stats = useQuery({ queryKey: ["seed", sid, "stats"], queryFn: () => api.get<any>(`/api/seeds/${sid}/stats`) });
  const deadlines = useQuery({ queryKey: ["deadlines", "all"], queryFn: () => api.get<any[]>("/api/deadlines?all=true"), retry: 0 });
  const [picking, setPicking] = useState(false);
  const saveSpec = useMutation({
    mutationFn: (text: string) => api.put(`/api/seeds/${sid}/spec`, { text }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["seed", sid, "spec"] }); toast("Spec sheet saved — the next round reads it"); },
  });
  const patch = useMutation({
    mutationFn: (p: Partial<Seed>) => api.patch(`/api/seeds/${sid}`, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seed", sid] }),
    onError: (e: Error) => toast(e.message, "err"),
  });
  const compost = useMutation({ mutationFn: () => api.post(`/api/seeds/${sid}/compost`), onSuccess: () => { toast("Moved to compost"); qc.invalidateQueries({ queryKey: ["seeds"] }); go("/greenhouse"); } });
  const del = useMutation({ mutationFn: () => api.del(`/api/seeds/${sid}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["seeds"] }); go("/greenhouse"); } });
  const confOptions = useMemo(() => {
    const m = new Map<string, any>();
    (deadlines.data ?? []).forEach((c) => { if (!m.has(c.title)) m.set(c.title, c); });
    return [...m.values()].sort((a, b) => (a.deadline || "").localeCompare(b.deadline || ""));
  }, [deadlines.data]);

  if (seed.isLoading) return <Spinner />;
  const s = seed.data;
  if (!s) return <div className="p-8 text-subtext">Seed not found.</div>;
  const stageIdx = s.state === "picked" ? 2 : STAGES.findIndex((x) => x.id === (s.stage?.stage ?? "seed"));
  const f = files.data;
  const upcoming = (deadlines.data ?? []).filter((c) => s.conference_targets.some((t) => c.title === t || c.id === t));

  return (
    <Page header={<>
      <button onClick={() => go("/greenhouse")} className="rounded-md p-1 text-subtext hover:bg-hover" title="Greenhouse"><ArrowLeft size={16} /></button>
      <PageTitle sub={`${TIER_LABEL[s.tier]} · ${s.origin}`}>{s.title}</PageTitle>
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" onClick={() => go(`/seed/${sid}`)}><MessageCircle size={12} />Open chat</Button>
        <Button size="sm" kind="primary" onClick={() => setPicking(true)} disabled={!s.flower}><Flower2 size={12} />Pick flower</Button>
      </div>
    </>}>
      <div className="mx-auto max-w-[920px] px-6 py-6">
        {/* Overview + stage */}
        <div className="mb-6 rounded-xl border border-border-soft p-5">
          <p className="m-0 text-[15px] leading-relaxed">{s.prompt}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Priority value={s.priority} />
            {s.technologies.map((t) => <Chip key={t}>{t}</Chip>)}
            {s.constraints.compute && <Chip tone="blue">{s.constraints.compute}</Chip>}
            {s.constraints.time && <Chip tone="blue">{s.constraints.time}</Chip>}
            {s.constraints.must_use.map((t) => <Chip key={t} tone="leaf">uses {t}</Chip>)}
            {s.constraints.must_avoid.map((t) => <Chip key={t} tone="amber">avoids {t}</Chip>)}
          </div>
          <div className="mt-5 flex items-center">
            {STAGES.map((st, i) => (
              <div key={st.id} className="flex flex-1 items-center">
                <div className="flex flex-col items-center gap-1" title={st.hint}>
                  <span className={cx("flex h-7 w-7 items-center justify-center rounded-full border-2 text-[12px] font-bold",
                    i < stageIdx ? "border-leaf bg-leaf text-white" : i === stageIdx ? "border-leaf text-leaf-ink" : "border-border text-muted")}>{i + 1}</span>
                  <span className={cx("text-[13px]", i === stageIdx ? "font-semibold" : "text-subtext")}>{st.label}</span>
                </div>
                {i < STAGES.length - 1 && <div className={cx("mx-2 mb-5 h-0.5 flex-1 rounded", i < stageIdx ? "bg-leaf" : "bg-border-soft")} />}
              </div>
            ))}
          </div>
          <div className="mt-1 text-center text-[12.5px] text-muted">Judged by Florist · {s.stage?.why}</div>
        </div>

        <Section title="Spec sheet">
          <p className="mb-2 mt-0 text-[13.5px] text-subtext">The single source of truth for this seed. Florist reads it every round — paste notes, requirements, links.</p>
          {spec.data ? <MarkdownDoc text={spec.data.text} onSave={(t) => saveSpec.mutate(t)} saving={saveSpec.isPending} minHeight={220} startInPreview /> : <Spinner />}
        </Section>

        <div className="grid grid-cols-2 gap-6">
          <Section title="Targets">
            <div className="rounded-xl border border-border-soft p-4">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {s.conference_targets.map((t) => <Chip key={t} tone="leaf" onRemove={() => patch.mutate({ conference_targets: s.conference_targets.filter((x) => x !== t) })}>{t}</Chip>)}
                <select value="" onChange={(e) => e.target.value && patch.mutate({ conference_targets: [...s.conference_targets, e.target.value] })} className="h-7 py-0 text-[13px]">
                  <option value="">+ Conference…</option>
                  {confOptions.filter((c) => !s.conference_targets.includes(c.title)).map((c) => <option key={c.title} value={c.title}>{c.title} · {c.deadline?.slice(0, 10)}</option>)}
                </select>
              </div>
              {upcoming.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[13.5px] text-subtext"><CalendarDays size={12} />{c.title} {c.year}: <b className="text-text">{c.deadline?.slice(0, 10)}</b></div>
              ))}
              <label className="mt-3 flex items-center gap-2 text-[13.5px]">
                <span className="text-subtext">Hand off by</span>
                <input type="date" value={s.deadline} onChange={(e) => patch.mutate({ deadline: e.target.value })} className="h-7 px-2 py-0 text-[13.5px]" />
              </label>
            </div>
          </Section>
          <Section title="Connected">
            <div className="grid grid-cols-3 gap-2">
              <Tile icon={<FileText size={14} />} n={f?.papers.length} label="papers" onClick={() => go(`/seed/${sid}/reader`)} />
              <Tile icon={<GitFork size={14} />} n={f?.repos.length} label="repos" onClick={() => go(`/seed/${sid}/graph`)} />
              <Tile icon={<FlaskConical size={14} />} n={f?.experiments.length} label="experiments" onClick={() => go(`/seed/${sid}/visuals`)} />
              <Tile icon={<ImageIcon size={14} />} n={f?.artifacts.length} label="visuals" onClick={() => go(`/seed/${sid}/visuals`)} />
              <Tile icon={<Recycle size={14} />} n={f?.context.length} label="in context" onClick={() => go(`/seed/${sid}`)} />
              <Tile icon={<Package size={14} />} n={f?.packs.length} label="packs" onClick={() => setPicking(true)} />
            </div>
          </Section>
        </div>

        <Section title="Activity">
          <div className="rounded-xl border border-border-soft p-4">
            <div className="mb-4 flex gap-6">
              {[["Rounds", s.rounds_done], ["Model calls", stats.data?.calls ?? 0], ["Tokens", (stats.data?.tokens ?? 0).toLocaleString()], ["Spend", `$${(stats.data?.usd ?? 0).toFixed(2)}`], ["Directions", stats.data?.directions ?? 0], ["Pruned", stats.data?.pruned ?? 0]].map(([k, v]) => (
                <div key={k as string}><div className="text-[12.5px] text-subtext">{k}</div><div className="text-[19.5px] font-semibold tabular-nums">{v}</div></div>
              ))}
            </div>
            {stats.data && <Heatmap days={stats.data.heatmap} label="events" />}
          </div>
        </Section>

        <Section title="Lifecycle">
          <div className="flex gap-2">
            <Button size="sm" onClick={() => compost.mutate()}><Recycle size={12} />Move to compost</Button>
            <Button size="sm" kind="danger" onClick={() => confirm("Delete this seed and everything explored for it?") && del.mutate()}><Trash2 size={12} />Delete</Button>
          </div>
        </Section>
      </div>
      <PickDialog seedId={sid} open={picking} onClose={() => setPicking(false)} />
    </Page>
  );
}

function Tile({ icon, n, label, onClick }: { icon: React.ReactNode; n?: number; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-lg border border-border-soft px-3 py-2 text-left hover:border-border hover:bg-hover">
      <div className="flex items-center gap-1.5 text-subtext">{icon}<span className="text-[19.5px] font-semibold tabular-nums text-text">{n ?? "–"}</span></div>
      <div className="text-[12.5px] text-subtext">{label}</div>
    </button>
  );
}
