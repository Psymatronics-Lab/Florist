import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, FileCode2, Loader2, Lock, LockOpen, Palette, Play, SlidersHorizontal, Sprout, Square, Trash2 } from "lucide-react";
import { api, LearnedPref, Profile } from "../../api";
import MarkdownDoc from "../../components/MarkdownDoc";
import Mascot, { Mood, TypingDots } from "../../components/character/Mascot";
import { Button, cx, Spinner, toast } from "../../components/ui";
import { Card, SettingsTitle } from "./Settings";

const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MODES = [
  { id: "run", icon: Play, label: "Run", hint: "Grow queued seeds now" },
  { id: "scheduled", icon: Clock, label: "Scheduled", hint: "Only during the hours below" },
  { id: "stop", icon: Square, label: "Stop", hint: "No background growth" },
] as const;

export default function ProfileSettings() {
  const qc = useQueryClient();
  const prof = useQuery({ queryKey: ["profile"], queryFn: () => api.get<Profile>("/api/profile") });
  const doc = useQuery({ queryKey: ["profile-doc"], queryFn: () => api.get<{ text: string; path: string; begin: string; end: string }>("/api/profile/doc") });
  const [yaml, setYaml] = useState(false);
  const raw = useQuery({ queryKey: ["profile-raw"], queryFn: () => api.get<{ text: string }>("/api/profile/raw"), enabled: yaml });
  const put = useMutation({
    mutationFn: (patch: Partial<Profile>) => api.put<Profile>("/api/profile", patch),
    onSuccess: (p) => qc.setQueryData(["profile"], p),
  });
  const saveDoc = useMutation({
    mutationFn: (text: string) => api.put<Profile>("/api/profile/doc", { text }),
    onSuccess: (p) => {
      qc.setQueryData(["profile"], p);
      qc.invalidateQueries({ queryKey: ["profile-doc"] });
      qc.invalidateQueries({ queryKey: ["profile-raw"] });
      toast("Profile saved — Florist is updating its structured copy");
    },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const p = prof.data;
  if (!p || !doc.data) return <Spinner />;
  const dt = p.downtime;
  const w = dt.windows[0] ?? { days: DAYS, start: "01:00", end: "07:00" };
  const setDt = (patch: Partial<Profile["downtime"]>) => put.mutate({ downtime: { ...dt, ...patch } });

  return (
    <>
      <SettingsTitle title="Profile" sub="One document about you. Paste from a CV, a website or your notes — Florist reads it before every step." />

      <Appearance />

      <Card title="Greenhouse" icon={<Sprout size={15} />}>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex rounded-lg bg-surface p-0.5">
            {MODES.map(({ id, icon: Icon, label, hint }) => (
              <button key={id} title={hint} onClick={() => setDt({ mode: id })}
                className={cx("flex h-8 items-center gap-1.5 rounded-md px-3 text-[13.5px]", dt.mode === id ? "bg-base font-medium text-leaf-ink shadow-card" : "text-subtext")}>
                <Icon size={12} />{label}
              </button>
            ))}
          </div>
          <div className={cx("flex items-center gap-2 text-[13.5px]", dt.mode !== "scheduled" && "opacity-50")}>
            <Clock size={13} className="text-subtext" />
            <select value={w.start} onChange={(e) => setDt({ windows: [{ ...w, start: e.target.value }] })} className="h-7 px-1.5 py-0 text-[13.5px]">{HOURS.map((h) => <option key={h}>{h}</option>)}</select>
            <span className="text-subtext">to</span>
            <select value={w.end} onChange={(e) => setDt({ windows: [{ ...w, end: e.target.value }] })} className="h-7 px-1.5 py-0 text-[13.5px]">{HOURS.map((h) => <option key={h}>{h}</option>)}</select>
            <div className="ml-2 flex gap-0.5">
              {DAYS.map((d) => (
                <button key={d} onClick={() => setDt({ windows: [{ ...w, days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d] }] })}
                  className={cx("h-6 w-7 rounded text-[11.5px] capitalize", w.days.includes(d) ? "bg-leaf-soft font-medium text-leaf-ink" : "bg-surface text-muted")}>{d.slice(0, 2)}</button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13.5px]">
            <span className="text-subtext">Budget</span>
            <select value={dt.max_usd_per_window} onChange={(e) => setDt({ max_usd_per_window: Number(e.target.value) })} className="h-7 px-1.5 py-0 text-[13.5px]">
              {[0.25, 0.5, 1, 2, 5, 10].map((v) => <option key={v} value={v}>${v} / night</option>)}
            </select>
          </label>
        </div>
      </Card>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="m-0 text-[15px] font-semibold">profile.md</h2>
        <button onClick={() => setYaml((v) => !v)} className={cx("flex items-center gap-1 rounded-md px-2 py-1 text-[13px]", yaml ? "bg-selected" : "text-subtext hover:bg-hover")}>
          <FileCode2 size={12} />Florist's YAML
        </button>
      </div>
      {yaml ? (
        <div className="mb-6 overflow-hidden rounded-xl border border-border-soft">
          <div className="border-b border-border-soft bg-canvas px-4 py-2 text-[13px] text-subtext">Derived from profile.md after each save — read only.</div>
          <pre className="m-0 max-h-[60vh] overflow-auto px-5 py-4 font-mono text-[13px]">{raw.data?.text ?? "…"}</pre>
        </div>
      ) : (
        <div className="mb-6">
          <MarkdownDoc text={doc.data.text} outline onSave={(t) => saveDoc.mutate(t)} saving={saveDoc.isPending} minHeight={460}
            owned={{ begin: doc.data.begin, end: doc.data.end, label: "Florist's notes" }} />
          <p className="mt-2 text-[12.5px] text-muted">The tinted “Florist's notes” section is maintained by Florist from what you save, dismiss and pick. Everything else is yours.</p>
        </div>
      )}

      <details className="mb-6 rounded-xl border border-border-soft">
        <summary className="flex cursor-pointer items-center gap-2 px-5 py-3 text-[15px] font-semibold"><SlidersHorizontal size={14} className="text-subtext" />Other settings</summary>
        <div className="grid grid-cols-2 gap-6 border-t border-border-soft px-5 py-4">
          <label className="text-[13.5px]"><div className="mb-1">Fold feed items below · {Math.round(p.feed_fold_threshold * 100)}</div>
            <input type="range" min={0} max={0.9} step={0.05} value={p.feed_fold_threshold} onChange={(e) => put.mutate({ feed_fold_threshold: Number(e.target.value) })} className="w-full" /></label>
          <label className="text-[13.5px]"><div className="mb-1">Compost priority-1 seeds after · {p.compost_after_days} days</div>
            <input type="range" min={7} max={180} value={p.compost_after_days} onChange={(e) => put.mutate({ compost_after_days: Number(e.target.value) })} className="w-full" /></label>
        </div>
        <LearnedWeights prefs={p.learned_preferences} />
      </details>
    </>
  );
}

function LearnedWeights({ prefs }: { prefs: LearnedPref[] }) {
  const qc = useQueryClient();
  const patch = useMutation({ mutationFn: (v: { id: string; body: Partial<LearnedPref> }) => api.patch(`/api/profile/learned/${v.id}`, v.body), onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/profile/learned/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }) });
  const learn = useMutation({
    mutationFn: () => api.post<{ learned: unknown[] }>("/api/profile/learn"),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["profile"] }); qc.invalidateQueries({ queryKey: ["profile-doc"] }); toast(r.learned.length ? "Updated Florist's notes" : "Not enough behaviour yet"); },
  });
  const weights = prefs.filter((x) => x.kind !== "statement");
  return (
    <div className="border-t border-border-soft px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13.5px] font-medium">Learned weights <span className="font-normal text-muted">({weights.length})</span></span>
        <Button size="sm" busy={learn.isPending} onClick={() => learn.mutate()}>Learn from behaviour now</Button>
      </div>
      <div className="max-h-72 divide-y divide-border-soft overflow-auto">
        {weights.map((lp) => (
          <div key={lp.id} className="flex items-center gap-3 py-1.5 text-[13.5px]">
            <span className="w-20 text-[12px] uppercase tracking-wide text-muted">{lp.kind}</span>
            <span className="min-w-0 flex-1 truncate">{lp.key}</span>
            <input type="range" min={-1} max={1} step={0.05} value={lp.weight} onChange={(e) => patch.mutate({ id: lp.id, body: { weight: Number(e.target.value), locked: true } })} className="w-32" />
            <span className={cx("w-10 text-right tabular-nums", lp.weight >= 0 ? "text-leaf-ink" : "text-red")}>{lp.weight > 0 ? "+" : ""}{lp.weight.toFixed(2)}</span>
            <button onClick={() => patch.mutate({ id: lp.id, body: { locked: !lp.locked } })} className={lp.locked ? "text-leaf-ink" : "text-muted"}>{lp.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
            <button onClick={() => del.mutate(lp.id)} className="text-muted hover:text-red"><Trash2 size={12} /></button>
          </div>
        ))}
        {!weights.length && <div className="py-2 text-[13px] text-muted">Nothing learned yet.</div>}
      </div>
    </div>
  );
}

const EMOTES: { mood: Mood; label: string }[] = [
  { mood: "idle", label: "Idle" }, { mood: "wave", label: "Wave" }, { mood: "thinking", label: "Thinking" },
  { mood: "reading", label: "Reading" }, { mood: "searching", label: "Searching" }, { mood: "working", label: "Watering" },
  { mood: "happy", label: "Happy" }, { mood: "surprised", label: "Surprised" }, { mood: "confused", label: "Confused" },
  { mood: "sleep", label: "Sleep" },
];

function Appearance() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<any>("/api/settings") });
  const put = useMutation({
    mutationFn: (on: boolean) => api.put("/api/settings", { ui: { character_animations: on } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const [mood, setMood] = useState<Mood>("wave");
  const on = !!settings.data?.ui?.character_animations;
  return (
    <Card title="Appearance" icon={<Palette size={15} />}
      right={
        <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
          <span className="text-subtext">Character animations</span>
          <span className="relative inline-flex items-center">
            <input type="checkbox" checked={on} onChange={(e) => put.mutate(e.target.checked)} className="peer sr-only" />
            <span className="h-5 w-9 rounded-full bg-border transition peer-checked:bg-leaf" />
            <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
          </span>
        </label>
      }>
      <div className="flex items-center gap-6">
        <div className="flex h-[132px] w-[150px] shrink-0 items-center justify-center rounded-xl bg-canvas">
          <Mascot mood={mood} size={128} force />
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-2 mt-0 text-[13.5px] text-subtext">
            {on ? "The florist keeps you company while Florist thinks, reads, searches and grows your seeds."
              : <>Off: Florist uses standard indicators <span className="mx-1 inline-flex align-middle"><TypingDots /></span>
                <Loader2 size={13} className="inline animate-spin text-leaf" />. Turn it on to meet the florist.</>}
          </p>
          <div className="flex flex-wrap gap-1">
            {EMOTES.map((e) => (
              <button key={e.mood} onClick={() => setMood(e.mood)}
                className={cx("rounded-full border px-2.5 py-0.5 text-[13px]", mood === e.mood ? "border-leaf bg-leaf-soft text-leaf-ink" : "border-border-soft text-subtext hover:border-border")}>{e.label}</button>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
