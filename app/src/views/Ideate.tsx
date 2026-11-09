import { useEffect, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BookOpen, Check, Columns2, Compass, FileText, FlaskConical, Flower2, GitFork, Image as ImageIcon, Lightbulb, Loader2, Mic, MicOff,
  Microscope, Navigation, Network, Package, Paperclip, Play, Plus, Recycle, Rss, Search, Send, Settings2, Sprout, Square, Trash2,
  Volume2, VolumeX, Wand2, X,
} from "lucide-react";
import { Activity, api, ChatMsg, CtxItem, Graph, IdeateChat, Seed, SeedFiles, Tier, Visual } from "../api";
import { composerTarget, go } from "../App";
import FlowerPanel from "../components/FlowerPanel";
import Mascot, { Mood, TypingDots, useCharacterAnimations } from "../components/character/Mascot";
import GraphView from "../components/GraphView";
import { Fold, Page, PageTitle } from "../components/Layout";
import { Logo } from "../components/Logo";
import SeedTypeDialog from "../components/SeedTypeDialog";
import ModelPicker from "../components/ModelPicker";
import PickDialog from "../components/PickDialog";
import VisualsPanel from "../components/VisualsPanel";
import { Button, cx, Md, Segmented, Spinner, toast } from "../components/ui";
import { parseVoiceCommand, speak, useSpeech } from "../voice";

type SeedTab = "chat" | "graph" | "flower" | "visuals" | "reader";
/** Labels match COMPOSER_SKILLS in agent/context.py. `needsTopic`: can't run without something to look at. */
const SKILLS = [
  { id: "deep_research", icon: Microscope, label: "Deep research", hint: "Run the full research loop", needsTopic: true },
  { id: "literature", icon: BookOpen, label: "Review literature", hint: "Search and write a cited review", needsTopic: true },
  { id: "novelty", icon: Compass, label: "Check novelty", hint: "Closest work and the remaining gap", needsTopic: true },
  { id: "find_sources", icon: Rss, label: "Find feed sources", hint: "New sources that suit you", needsTopic: false },
  { id: "compost_ideas", icon: Recycle, label: "Compost ideas", hint: "Connect your compost into ideas", needsTopic: false },
  { id: "feed_ideas", icon: Lightbulb, label: "Feed ideas", hint: "Read part of your feed for ideas", needsTopic: false },
  { id: "polish", icon: Wand2, label: "Adaptive polish", hint: "Find the idea's stage and shore it up", needsTopic: true },
];
const skillLabel = (ids: string[]) => SKILLS.find((s) => s.id === ids[0])?.label ?? "";
const STARTERS = [
  { label: "Build with what I have", text: "What could I realistically build this month with my hardware? Give me three ideas that fit my skills and time." },
  { label: "Find a gap", text: "Find a gap in my interests worth a workshop paper. Tell me the idea and what makes it different." },
  { label: "Shape a vague idea", text: "Help me turn a vague idea into a weekend project. The idea is: " },
  { label: "What to learn next", text: "Given my interests, what should I learn next? Suggest one small project that would teach it." },
];
type Send = { text: string; skills: string[]; model: string; effort?: string; tier?: Tier | "" };
const STEP_LABEL: Record<string, string> = {
  ground: "Planning searches", search: "Searching", triage: "Reading", explore: "Exploring directions",
  check_search: "Finding closest work", check: "Checking novelty", smoke: "Designing smoke checks",
  exploit: "Ranking & pruning", visualize: "Drawing", render: "Rendering", flower: "Updating the flower",
};

const STEP_MOOD: Record<string, Mood> = {
  ground: "thinking", search: "searching", triage: "reading", explore: "thinking", check_search: "searching",
  check: "reading", smoke: "working", exploit: "thinking", visualize: "working", render: "working", flower: "thinking",
};

/** Waves hello, then settles into idle. */
function Greeter() {
  const [mood, setMood] = useState<Mood>("wave");
  useEffect(() => { const t = setTimeout(() => setMood("idle"), 2600); return () => clearTimeout(t); }, []);
  return <Mascot mood={mood} size={120} />;
}

function Thinking() {
  const on = useCharacterAnimations();
  return on
    ? <div className="flex items-center gap-1"><Mascot mood="thinking" size={70} /><span className="text-[13.5px] text-subtext">Thinking…</span></div>
    : <div className="flex items-center gap-2.5"><img src="/florist-icon.png" alt="" className="h-5 w-5" /><TypingDots /></div>;
}

export default function IdeateView({ mode, id, tab, activity }: { mode: "ideate" | "seed"; id?: string; tab?: string; activity: Activity[] }) {
  return mode === "seed" ? <SeedChat id={id!} tab={(tab as SeedTab) || "chat"} activity={activity} /> : <IdeateChatView id={id} />;
}

/* ------------------------------------------------------------------------------------------ */
/* Ideate (no seed yet)                                                                         */
/* ------------------------------------------------------------------------------------------ */

function IdeateChatView({ id }: { id?: string }) {
  const qc = useQueryClient();
  const chats = useQuery({ queryKey: ["ideate"], queryFn: () => api.get<IdeateChat[]>("/api/ideate") });
  const chat = useQuery({ queryKey: ["ideate", id], queryFn: () => api.get<IdeateChat>(`/api/ideate/${id}`), enabled: !!id });
  const [pending, setPending] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; n: number }>();
  const [seedDialog, setSeedDialog] = useState<{ research?: Send } | null>(null);
  const created = useRef<string | null>(null);
  useEffect(() => { if (!id) created.current = null; }, [id]);

  const ensure = async (): Promise<string> => {
    if (id) return id;
    if (created.current) return created.current; // several files attached before the route updates
    const c = await api.post<IdeateChat>("/api/ideate", {});
    created.current = c.id;
    go(`/ideate/${c.id}`);
    return c.id;
  };
  const send = useMutation({
    mutationFn: async (v: Send) => {
      const cid = await ensure();
      setPending(v.text || skillLabel(v.skills));
      return api.post<{ reply: string; seed_id?: string }>(`/api/ideate/${cid}/message`, { message: v.text, skills: v.skills, model: v.model || undefined, effort: v.effort || undefined, tier: v.tier || undefined });
    },
    onSuccess: (r) => {
      if (!r.seed_id) return;
      setSeedDialog(null);
      qc.invalidateQueries({ queryKey: ["seeds"] });
      go(`/seed/${r.seed_id}`);
    },
    onSettled: () => { setPending(null); qc.invalidateQueries({ queryKey: ["ideate"] }); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const addCtx = async (item: CtxItem) => {
    const cid = await ensure();
    await api.post(`/api/ideate/${cid}/context`, item);
    qc.invalidateQueries({ queryKey: ["ideate"] });
  };
  const removeCtx = (item: CtxItem) => id && api.del(`/api/ideate/${id}/context/${item.kind}/${item.id}`).then(() => qc.invalidateQueries({ queryKey: ["ideate"] }));
  const toSeed = useMutation({
    mutationFn: (tier: Tier | "") => api.post<{ seed: Seed }>(`/api/ideate/${id}/seed`, { tier }),
    onSuccess: (r) => { setSeedDialog(null); qc.invalidateQueries({ queryKey: ["seeds"] }); toast(`Planted “${r.seed.title}”`); go(`/seed/${r.seed.id}`); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const del = useMutation({ mutationFn: (cid: string) => api.del(`/api/ideate/${cid}`), onSuccess: (_, cid) => { qc.invalidateQueries({ queryKey: ["ideate"] }); if (cid === id) go("/"); } });

  const msgs = chat.data?.messages ?? [];
  const context = chat.data?.context ?? [];
  const converted = !!chat.data?.seed_id;

  return (
    <Page
      header={<>
        <PageTitle sub={id ? `${msgs.length} messages` : undefined}>{chat.data?.title ?? "Ideate"}</PageTitle>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" kind="ghost" onClick={() => go("/")}><Plus size={13} />New chat</Button>
        </div>
      </>}
      bodyClass="overflow-hidden"
      inspector={
        <div className="flex h-full flex-col overflow-auto">
          <div className="border-b border-border-soft p-4">
            {converted ? (
              <Button kind="secondary" className="w-full" onClick={() => go(`/seed/${chat.data!.seed_id}`)}><Sprout size={13} />Open its seed</Button>
            ) : (
              <Button kind="primary" className="w-full" disabled={!id || msgs.length < 2} onClick={() => setSeedDialog({})}>
                <Sprout size={13} />Turn into a seed
              </Button>
            )}
          </div>
          <ContextFold items={context} onRemove={removeCtx} />
          <RelatedCompost onAdd={addCtx} />
          <Fold title="Recent chats" icon={<Lightbulb size={13} />} count={chats.data?.length} open={false}>
            <div className="flex flex-col">
              {chats.data?.map((c) => (
                <div key={c.id} className={cx("group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] hover:bg-hover", c.id === id && "bg-selected")}>
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => go(`/ideate/${c.id}`)}>{c.title}</button>
                  {c.seed_id && <Sprout size={11} className="text-leaf" />}
                  <button className="text-muted opacity-0 hover:text-red group-hover:opacity-100" onClick={() => del.mutate(c.id)}><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          </Fold>
        </div>
      }>
      <div className="flex h-full flex-col">
        <Messages msgs={msgs} pending={pending} thinking={send.isPending}
          empty={<IdeateEmpty onPick={(text) => setPrefill((p) => ({ text, n: (p?.n ?? 0) + 1 }))} />}
          onSeed={!converted && id ? () => setSeedDialog({}) : undefined} />
        <Composer context={context} onRemoveCtx={removeCtx} onAddCtx={addCtx} prefill={prefill} hasTopic={msgs.length > 0}
          busy={send.isPending} onSend={(text, skills, model, effort) => (skills.includes("deep_research")
            ? setSeedDialog({ research: { text, skills, model, effort } })
            : send.mutate({ text, skills, model, effort }))} />
      </div>
      <SeedTypeDialog auto open={!!seedDialog} busy={toSeed.isPending || send.isPending}
        action={seedDialog?.research ? "Plant and research" : "Plant seed"}
        onClose={() => { if (seedDialog?.research?.text) { const text = seedDialog.research.text; setPrefill((p) => ({ text, n: (p?.n ?? 0) + 1 })); } setSeedDialog(null); }}
        onPick={(tier) => (seedDialog?.research ? send.mutate({ ...seedDialog.research, tier }) : toSeed.mutate(tier))} />
    </Page>
  );
}

function IdeateEmpty({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <Greeter />
      <div className="text-[19.5px] font-semibold">What are you curious about?</div>
      <div className="flex max-w-[620px] flex-wrap justify-center gap-1.5">
        {STARTERS.map((s) => (
          <button key={s.label} onClick={() => onPick(s.text)} title={s.text} className="rounded-full border border-border-soft px-3 py-1.5 text-[13.5px] text-subtext hover:border-border hover:text-text">{s.label}</button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Seed chat (same layout, with views and the seed's files)                                    */
/* ------------------------------------------------------------------------------------------ */

function SeedChat({ id, tab, activity }: { id: string; tab: SeedTab; activity: Activity[] }) {
  const qc = useQueryClient();
  const seed = useQuery({ queryKey: ["seed", id], queryFn: () => api.get<Seed>(`/api/seeds/${id}`), refetchInterval: (q) => (q.state.data?.run ? 2500 : false) });
  const sid = seed.data?.id ?? id;
  const chat = useQuery({ queryKey: ["seed", sid, "chat"], queryFn: () => api.get<ChatMsg[]>(`/api/seeds/${sid}/chat`) });
  const files = useQuery({ queryKey: ["seed", sid, "files"], queryFn: () => api.get<SeedFiles>(`/api/seeds/${sid}/files`) });
  const graph = useQuery({ queryKey: ["seed", sid, "graph"], queryFn: () => api.get<Graph>(`/api/seeds/${sid}/graph`), enabled: tab === "graph" || tab === "flower" });
  const visuals = useQuery({ queryKey: ["seed", sid, "visuals"], queryFn: () => api.get<Visual[]>(`/api/seeds/${sid}/visuals`) });
  const [split, setSplit] = useState(false);
  const [rounds, setRounds] = useState(1);
  const [picking, setPicking] = useState(false);
  const [paper, setPaper] = useState<string>("");
  const [pending, setPending] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<"ask" | "steer" | "idea">("ask");

  const s = seed.data;
  const running = !!s?.run && s.run.status === "running";
  useEffect(() => { if (running) setChatMode((m) => (m === "ask" ? "idea" : m)); }, [running]);
  const lastStep = activity.filter((a) => a.seed_id === sid && a.kind === "loop").at(-1)?.message;
  const lastBloom = activity.filter((a) => a.seed_id === sid && /Flower v\d+ updated|Picked/.test(a.message)).at(-1)?.id;
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!lastBloom) return;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 3800);
    return () => clearTimeout(t);
  }, [lastBloom]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["seed", sid] });

  const grow = useMutation({ mutationFn: () => api.post(`/api/seeds/${sid}/grow`, { rounds }), onSuccess: invalidate, onError: (e: Error) => toast(e.message, "err") });
  const stop = useMutation({ mutationFn: () => api.post(`/api/seeds/${sid}/stop`), onSuccess: () => toast("Stopping after this step") });
  const send = useMutation({
    mutationFn: async (v: Send) => {
      setPending(v.text || skillLabel(v.skills));
      if (chatMode === "idea") return api.post<any>(`/api/seeds/${sid}/idea`, { idea: v.text });
      if (chatMode === "steer") return api.post<any>(`/api/seeds/${sid}/steer`, { note: v.text });
      return api.post<any>(`/api/seeds/${sid}/chat`, { message: v.text, skills: v.skills, model: v.model || undefined, effort: v.effort || undefined });
    },
    onSuccess: (r) => {
      if (chatMode === "idea") toast(r?.applied === "live" ? "Folded into the running exploration" : "Saved — shapes the next round");
      if (chatMode === "steer") toast("Noted for the next round");
    },
    onSettled: () => { setPending(null); invalidate(); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const addCtx = async (item: CtxItem) => {
    await api.post(`/api/seeds/${sid}/context`, item);
    invalidate();
    toast("Added to the seed's context");
  };
  const removeCtx = (item: CtxItem) => api.del(`/api/seeds/${sid}/context/${item.kind}/${item.id}`).then(invalidate);
  const setTab = (t: SeedTab) => go(`/seed/${sid}/${t}`);
  const openPaper = (url: string) => { setPaper(url); setTab("reader"); };

  if (seed.isLoading) return <Spinner label="Opening seed…" />;
  if (!s) return <div className="p-8 text-subtext">Seed not found.</div>;

  const chatPane = (
    <div className="flex h-full flex-col">
      <Messages msgs={chat.data ?? []} pending={pending} thinking={send.isPending && chatMode === "ask"}
        empty={<SeedEmpty seed={s} onGrow={() => grow.mutate()} />} />
      <Composer context={(files.data?.context ?? []) as CtxItem[]} onRemoveCtx={removeCtx} onAddCtx={addCtx} busy={send.isPending} compact={split && tab !== "chat"} hasTopic
        seedMode={{ mode: chatMode, setMode: setChatMode, running }}
        onVoice={(cmd) => (cmd === "grow" ? grow.mutate() : cmd === "stop" ? stop.mutate() : setPicking(true))}
        onSend={(text, skills, model, effort) => send.mutate({ text, skills, model, effort })} />
    </div>
  );
  const viewPane = (t: SeedTab) => {
    if (t === "graph") return graph.data ? <GraphView graph={graph.data} /> : <Spinner />;
    if (t === "flower") return <div className="h-full overflow-auto"><FlowerPanel seedId={sid} graph={graph.data} visuals={visuals.data ?? []} /></div>;
    if (t === "visuals") return <div className="h-full overflow-auto"><VisualsPanel seedId={sid} visuals={visuals.data ?? []} mermaidGraph={graph.data?.mermaid} /></div>;
    if (t === "reader") return <Reader papers={files.data?.papers ?? []} url={paper} onPick={setPaper} />;
    return chatPane;
  };

  return (
    <Page
      bodyClass="overflow-hidden relative"
      header={<>
        <PageTitle sub={running ? <span className="text-leaf-ink">{STEP_LABEL[s.run!.step] ?? "Working"} · round {s.run!.round}</span> : s.stage?.why}>{s.title}</PageTitle>
        <StagePill stage={s.state === "picked" ? "flower" : s.stage?.stage ?? "seed"} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Segmented value={tab} onChange={setTab} options={[
            { value: "chat", label: <span title="Chat">Chat</span> },
            { value: "graph", label: <Network size={13} /> },
            { value: "flower", label: <Flower2 size={13} /> },
            { value: "visuals", label: <span className="flex items-center gap-1"><ImageIcon size={13} />{s.pending_smoke > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber" />}</span> },
            { value: "reader", label: <FileText size={13} /> },
          ]} />
          <button title="Chat side by side" onClick={() => setSplit((v) => !v)} disabled={tab === "chat"}
            className={cx("rounded-md p-1.5 disabled:opacity-30", split ? "bg-leaf-soft text-leaf-ink" : "text-subtext hover:bg-hover")}><Columns2 size={14} /></button>
          <span className="mx-1 h-5 w-px bg-border-soft" />
          {running ? (
            <Button size="sm" onClick={() => stop.mutate()}><Square size={11} />Stop</Button>
          ) : (
            <div className="flex">
              <Button size="sm" kind="primary" className="rounded-r-none" busy={grow.isPending} onClick={() => grow.mutate()}><Play size={12} />Grow</Button>
              <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} title="Rounds" className="h-8 rounded-l-none border-l-0 px-1 py-0 text-[13px]">
                {[1, 2, 3, 5].map((n) => <option key={n} value={n}>×{n}</option>)}
              </select>
            </div>
          )}
          <Button size="sm" onClick={() => setPicking(true)} disabled={!s.flower}><Flower2 size={12} />Pick</Button>
          <button title="Seed options" onClick={() => go(`/greenhouse/${sid}`)} className="rounded-md p-1.5 text-subtext hover:bg-hover"><Settings2 size={15} /></button>
        </div>
      </>}
      inspector={<SeedInspector seed={s} files={files.data} onOpenPaper={openPaper} onView={setTab} onAdd={addCtx} onRemove={removeCtx} />}>
      {split && tab !== "chat"
        ? <div className="flex h-full"><div className="h-full w-[44%] border-r border-border-soft">{chatPane}</div><div className="h-full min-w-0 flex-1">{viewPane(tab)}</div></div>
        : viewPane(tab)}
      {running && tab !== "graph" && (
        <div className="pointer-events-none absolute bottom-24 right-5 rounded-xl border border-border-soft bg-base/95 px-3 py-2 shadow-pop">
          <Mascot mood={STEP_MOOD[s.run!.step] ?? "working"} size={84} label={lastStep ? lastStep.slice(0, 40) : "Growing…"} />
        </div>
      )}
      {celebrate && !running && (
        <div className="pointer-events-none absolute bottom-24 right-5 rounded-xl border border-leaf/40 bg-base/95 px-3 py-2 shadow-pop">
          <Mascot mood="happy" size={84} label="The flower opened" />
        </div>
      )}
      <PickDialog seedId={sid} open={picking} onClose={() => setPicking(false)} />
    </Page>
  );
}

function SeedEmpty({ seed, onGrow }: { seed: Seed; onGrow: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Mascot mood="idle" size={92} />
      <div className="max-w-[520px] text-[14.5px] text-subtext">{seed.prompt}</div>
      {!seed.flower && <Button kind="primary" onClick={onGrow}><Play size={12} />Grow the first round</Button>}
      <div className="text-[13px] text-muted">Ask questions, steer, or drop in another idea — drag papers and compost here for context.</div>
    </div>
  );
}

export function StagePill({ stage }: { stage: "seed" | "growing" | "flower" }) {
  const s = { seed: ["bg-surface text-subtext", "Seed"], growing: ["bg-blue-soft text-blue", "Growing"], flower: ["bg-leaf-soft text-leaf-ink", "Flower"] }[stage];
  return <span className={cx("rounded-full px-2 py-[1px] text-[12px] font-medium", s[0])} title="Stage judged by Florist">{s[1]}</span>;
}

function SeedInspector({ seed, files, onOpenPaper, onView, onAdd, onRemove }: {
  seed: Seed; files?: SeedFiles; onOpenPaper: (url: string) => void; onView: (t: SeedTab) => void; onAdd: (i: CtxItem) => void; onRemove: (i: CtxItem) => void;
}) {
  const f = files;
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3 text-[13px] text-subtext">
        <span title="Rounds">{seed.rounds_done} rounds</span>·<span title="Sources read">{seed.counts?.source ?? 0} sources</span>·<span>${seed.usd.toFixed(2)}</span>
        <button className="ml-auto text-leaf-ink hover:underline" onClick={() => go(`/greenhouse/${seed.id}`)}>Options</button>
      </div>
      <ContextFold items={(f?.context ?? []) as CtxItem[]} onRemove={onRemove} />
      <Fold title="Papers" icon={<FileText size={13} />} count={f?.papers.length}>
        <div className="flex max-h-56 flex-col overflow-auto">
          {f?.papers.slice(0, 30).map((p) => <DraggableSource key={p.id} item={p} onOpen={() => (p.pdf ? onOpenPaper(p.url) : window.open(p.url, "_blank"))} />)}
          {!f?.papers.length && <span className="text-[13px] text-muted">Grow the seed to gather papers.</span>}
        </div>
      </Fold>
      <Fold title="Repositories" icon={<GitFork size={13} />} count={f?.repos.length} open={false}>
        {f?.repos.map((r) => (
          <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1 py-1 text-[13.5px] hover:bg-hover">
            <Logo id="github" size={13} /><span className="min-w-0 flex-1 truncate">{r.title}</span>{r.stars != null && <span className="text-[12px] text-muted">★{r.stars}</span>}
          </a>
        ))}
      </Fold>
      <Fold title="Experiments" icon={<FlaskConical size={13} />} count={f?.experiments.length} open={!!f?.experiments.some((e) => e.status === "pending")}>
        {f?.experiments.map((e) => (
          <button key={e.id} onClick={() => onView("visuals")} className="flex w-full items-start gap-2 rounded px-1 py-1 text-left text-[13.5px] hover:bg-hover">
            <span className={cx("mt-1 h-2 w-2 shrink-0 rounded-full", { passed: "bg-leaf", failed: "bg-red", pending: "bg-amber", running: "bg-blue" }[e.status] ?? "bg-border")} />
            <span className="line-clamp-2">{e.assumption}</span>
          </button>
        ))}
        {!f?.experiments.length && <span className="text-[13px] text-muted">No smoke checks yet.</span>}
      </Fold>
      <Fold title="Artifacts" icon={<Package size={13} />} count={(f?.artifacts.length ?? 0) + (f?.packs.length ?? 0)} open={false}>
        {f?.artifacts.map((a) => (
          <button key={a.id} onClick={() => onView("visuals")} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[13.5px] hover:bg-hover">
            <ImageIcon size={12} className="text-purple" /><span className="truncate">{a.title}</span>
          </button>
        ))}
        {f?.packs.map((p) => (
          <div key={p.path} className="flex items-center gap-2 px-1 py-1 text-[13.5px]" title={p.path}>
            <Package size={12} className="text-leaf" /><span className="truncate">Flower pack · {p.created.slice(0, 10)}</span>
          </div>
        ))}
      </Fold>
      <RelatedCompost onAdd={onAdd} />
    </div>
  );
}

function DraggableSource({ item, onOpen }: { item: SeedFiles["papers"][number]; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `src:${item.id}`, data: { type: "source", item } });
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} onClick={onOpen} title={item.title}
      className={cx("flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[13.5px] hover:bg-hover", isDragging && "opacity-40")}>
      <Logo id={item.tool === "compost" ? "compost" : item.tool || "paper"} size={13} />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {item.year && <span className="text-[12px] text-muted">{item.year}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Shared pieces                                                                                */
/* ------------------------------------------------------------------------------------------ */

function ContextFold({ items, onRemove }: { items: CtxItem[]; onRemove: (i: CtxItem) => void }) {
  return (
    <Fold title="In context" icon={<Plus size={13} />} count={items.length}>
      {!items.length && <div className="text-[13px] text-muted">Drag feed items, compost or papers onto the chat.</div>}
      <div className="flex flex-col gap-1">
        {items.map((c) => (
          <div key={`${c.kind}:${c.id}`} className="group flex items-center gap-2 text-[13.5px]">
            {c.kind === "feed" ? <Rss size={12} className="text-amber" /> : c.kind === "compost" ? <Recycle size={12} className="text-leaf" /> : <FileText size={12} className="text-blue" />}
            <span className="min-w-0 flex-1 truncate">{c.title ?? c.id}</span>
            <button onClick={() => onRemove(c)} className="text-muted opacity-0 hover:text-red group-hover:opacity-100"><X size={12} /></button>
          </div>
        ))}
      </div>
    </Fold>
  );
}

function RelatedCompost({ onAdd }: { onAdd: (i: CtxItem) => void }) {
  const [q, setQ] = useState("");
  const res = useQuery({ queryKey: ["compost", "search", q], queryFn: () => api.get<{ id: string; title: string; tags: string[] }[]>(`/api/compost/search?q=${encodeURIComponent(q)}`) });
  return (
    <Fold title="Related compost" icon={<Recycle size={13} />}>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search compost" className="h-7 w-full pl-7 text-[13.5px]" />
      </div>
      <div className="flex flex-col">
        {res.data?.map((c) => <CompostChip key={c.id} item={c} onAdd={() => onAdd({ kind: "compost", id: c.id, title: c.title })} />)}
        {res.data && !res.data.length && <span className="text-[13px] text-muted">Nothing found.</span>}
      </div>
    </Fold>
  );
}

function CompostChip({ item, onAdd }: { item: { id: string; title: string }; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `rc:${item.id}`, data: { type: "compost", item } });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={cx("group flex cursor-grab items-center gap-2 rounded px-1 py-1 text-[13.5px] hover:bg-hover", isDragging && "opacity-40")}>
      <Recycle size={12} className="shrink-0 text-leaf" /><span className="min-w-0 flex-1 truncate">{item.title}</span>
      <button title="Add to context" onClick={onAdd} className="text-muted opacity-0 hover:text-leaf-ink group-hover:opacity-100"><Plus size={13} /></button>
    </div>
  );
}

function Messages({ msgs, pending, thinking, empty, onSeed }: { msgs: ChatMsg[]; pending: string | null; thinking: boolean; empty: React.ReactNode; onSeed?: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, pending, thinking]);
  if (!msgs.length && !pending) return <div className="min-h-0 flex-1 overflow-auto">{empty}</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 py-6">
        {msgs.map((m) => <Message key={m.id} m={m} onSeed={onSeed} />)}
        {pending && !msgs.some((m) => m.role === "user" && m.content === pending) && <Message m={{ id: -1, role: "user", content: pending, actions: [], created: "" }} />}
        {thinking && <Thinking />}
        <div ref={end} />
      </div>
    </div>
  );
}

function Message({ m, onSeed }: { m: ChatMsg; onSeed?: () => void }) {
  if (m.role === "user") {
    const skills = m.actions?.find((a: any) => a.type === "skills")?.skills as string[] | undefined;
    const S = SKILLS.find((x) => x.id === skills?.[0]);
    return (
      <div className="ml-auto max-w-[80%]">
        <div className="rounded-2xl rounded-br-md bg-leaf-soft px-3.5 py-2 text-[14.5px]">{m.content}</div>
        {S && S.label !== m.content && <div className="mt-1 flex items-center justify-end gap-1 text-[12px] text-muted"><S.icon size={11} />{S.label}</div>}
      </div>
    );
  }
  if (m.role === "steer" || m.role === "idea") {
    return (
      <div className={cx("ml-auto flex max-w-[80%] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13.5px]", m.role === "idea" ? "border-amber/50 bg-amber-soft/50" : "border-border-soft")}>
        {m.role === "idea" ? <Lightbulb size={12} className="text-amber" /> : <Navigation size={12} className="text-subtext" />}{m.content}
      </div>
    );
  }
  const suggest = m.actions?.find((a: any) => a.type === "suggest_seed");
  const acts = m.actions?.filter((a: any) => ["steer", "prune", "boost", "deepen", "add_constraint", "set_tier", "run_round"].includes(a.type));
  const found = m.actions?.find((a: any) => a.type === "suggest_sources")?.sources as FoundSource[] | undefined;
  return (
    <div className="flex gap-2.5">
      <img src="/florist-icon.png" alt="" className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1 text-[14.5px]">
        <Md>{m.content}</Md>
        {acts?.map((a: any, i: number) => <div key={i} className={cx("text-[12.5px]", a.ok ? "text-leaf-ink" : "text-red")}>↳ {a.type} {a.note || a.target}</div>)}
        {found && <div className="mt-2 flex flex-col gap-1.5">{found.map((s) => <SourceCard key={s.name} source={s} />)}</div>}
        {suggest && onSeed && (
          <button onClick={onSeed} className="mt-1 flex items-center gap-2 rounded-lg border border-leaf/50 bg-leaf-soft/40 px-3 py-2 text-[13.5px] hover:bg-leaf-soft">
            <Sprout size={13} className="text-leaf" /><span>Turn into a seed{suggest.title ? `: ${suggest.title}` : ""}</span>
          </button>
        )}
      </div>
    </div>
  );
}

type FoundSource = { kind: string; name: string; config: Record<string, any>; why: string; ok: boolean };

function SourceCard({ source }: { source: FoundSource }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: async () => {
      const s = await api.post<{ id: string }>("/api/sources", { kind: source.kind, name: source.name, config: source.config });
      await api.post("/api/feed/fetch", { source_id: s.id, force: true });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sources"] }); toast(`Added ${source.name}`); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border-soft px-3 py-2">
      <Logo id={source.kind} size={15} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium">{source.name}</div>
        {source.why && <div className="truncate text-[12.5px] text-subtext" title={source.why}>{source.why}</div>}
        {!source.ok && <div className="flex items-center gap-1 text-[12.5px] text-amber"><AlertTriangle size={10} />Couldn't reach this source</div>}
      </div>
      {add.isSuccess
        ? <span className="flex items-center gap-1 text-[13px] text-leaf-ink"><Check size={12} />Added</span>
        : <Button size="sm" busy={add.isPending} onClick={() => add.mutate()}><Plus size={12} />Add</Button>}
    </div>
  );
}

const readBase64 = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",")[1] ?? "");
  r.onerror = () => fail(new Error(`Couldn't read ${f.name}`));
  r.readAsDataURL(f);
});
const ATTACHABLE = ".pdf,.txt,.md,.rst,.tex,.csv,.tsv,.json,.yaml,.yml,.html,.xml,.ipynb,.py,.js,.ts,.tsx,.jsx,.c,.h,.cpp,.rs,.go,.java,.sh";

/** The plus button: skills and file attachment stay hidden until asked for. */
function PlusMenu({ skill, onSkill, onFiles, attaching }: { skill: string; onSkill: (id: string) => void; onFiles: (files: File[]) => void; attaching: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button title="Skills and files" aria-label="Skills and files" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={cx("flex h-8 w-8 items-center justify-center rounded-md transition-colors", open ? "bg-leaf-soft text-leaf-ink" : "text-subtext hover:bg-hover hover:text-text")}>
        {attaching ? <Loader2 size={15} className="animate-spin" /> : <Plus size={16} className={cx("transition-transform", open && "rotate-45")} />}
      </button>
      <input ref={input} type="file" multiple hidden accept={ATTACHABLE} onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) onFiles(fs); }} />
      {open && (
        <div className="picker-pop absolute bottom-full left-0 z-30 mb-2 w-[300px] rounded-2xl border border-border-soft bg-base/95 p-1.5 shadow-pop backdrop-blur-md" style={{ transformOrigin: "bottom left" }}>
          <button onClick={() => { setOpen(false); input.current?.click(); }} className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-hover">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface"><Paperclip size={14} className="text-subtext" /></span>
            <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">Attach files</span><span className="block truncate text-[12px] text-muted">PDFs, text and code</span></span>
          </button>
          <div className="mx-2.5 my-1 h-px bg-border-soft" />
          <div className="px-2.5 pb-0.5 pt-1 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">Skills</div>
          {SKILLS.map(({ id, icon: Icon, label, hint }) => (
            <button key={id} onClick={() => { onSkill(skill === id ? "" : id); setOpen(false); }}
              className={cx("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors", skill === id ? "bg-leaf-soft/60" : "hover:bg-hover")}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface"><Icon size={14} className="text-subtext" /></span>
              <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{label}</span><span className="block truncate text-[12px] text-muted">{hint}</span></span>
              {skill === id && <Check size={14} className="shrink-0 text-leaf" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ context, onRemoveCtx, onAddCtx, onSend, busy, seedMode, onVoice, compact, prefill, hasTopic }: {
  context: CtxItem[]; onRemoveCtx: (i: CtxItem) => void; onAddCtx: (i: CtxItem) => void | Promise<void>;
  onSend: (text: string, skills: string[], model: string, effort: string) => void; busy: boolean;
  seedMode?: { mode: "ask" | "steer" | "idea"; setMode: (m: "ask" | "steer" | "idea") => void; running: boolean };
  onVoice?: (cmd: "grow" | "stop" | "pick") => void; compact?: boolean; prefill?: { text: string; n: number }; hasTopic?: boolean;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(prefill.text.length, prefill.text.length); });
  }, [prefill]);
  const [skill, setSkill] = useState("");
  const [attaching, setAttaching] = useState(false);
  const attach = async (files: File[]) => {
    setAttaching(true);
    for (const f of files) {
      try {
        const a = await api.post<{ id: string; name: string }>("/api/attachments", { name: f.name, mime: f.type, data: await readBase64(f) });
        await onAddCtx({ kind: "file", id: a.id, title: a.name });
      } catch (e) { toast((e as Error).message, "err"); }
    }
    setAttaching(false);
  };
  const [model, setModel] = useState(() => { try { return localStorage.getItem("florist-model") || ""; } catch { return ""; } });
  const [effort, setEffort] = useState(() => { try { return localStorage.getItem("florist-effort") || ""; } catch { return ""; } });
  useEffect(() => { try { localStorage.setItem("florist-model", model); localStorage.setItem("florist-effort", effort); } catch { /* ignore */ } }, [model, effort]);
  const [voice, setVoice] = useState(false);
  const { setNodeRef, isOver, active } = useDroppable({ id: "drop:composer" });
  useEffect(() => { composerTarget.current = onAddCtx; return () => { composerTarget.current = null; }; }, [onAddCtx]);
  const asking = !seedMode || seedMode.mode === "ask";
  const chosen = asking ? SKILLS.find((s) => s.id === skill) : undefined;
  const canSendEmpty = !!chosen && (!chosen.needsTopic || !!hasTopic);
  const submit = (t = text) => {
    const v = t.trim();
    if ((!v && !canSendEmpty) || busy) return;
    setText(""); setSkill("");
    onSend(v, chosen ? [chosen.id] : [], model, effort);
  };
  const speech = useSpeech((said) => {
    const c = parseVoiceCommand(said);
    if (onVoice && (c.cmd === "grow" || c.cmd === "stop" || c.cmd === "pick")) { onVoice(c.cmd); if (voice) speak(c.cmd === "grow" ? "Growing." : c.cmd === "stop" ? "Stopping." : "Opening pick."); return; }
    if (seedMode && (c.cmd === "idea" || c.cmd === "steer")) { seedMode.setMode(c.cmd); submit(c.text); return; }
    if (voice) submit(said); else setText((t) => (t ? t + " " : "") + said);
  });
  const placeholder = seedMode?.mode === "idea" ? (seedMode.running ? "Another idea — folded into the running search" : "Another idea for this seed")
    : seedMode?.mode === "steer" ? "Steer the next round, e.g. focus on Rust"
    : chosen ? (chosen.needsTopic && !hasTopic ? `What should ${chosen.label.toLowerCase()} look at?` : "Add a focus, or just send")
    : "Ask, brainstorm, or drop items here for context…";

  return (
    <div className="border-t border-border-soft bg-base px-6 pb-4 pt-3">
      <div ref={setNodeRef} className={cx("mx-auto max-w-[760px] rounded-xl border bg-base shadow-card transition-colors",
        active ? (isOver ? "border-leaf bg-leaf-soft/40" : "border-dashed border-leaf") : "border-border")}>
        {context.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b border-border-soft px-3 py-2">
            {context.map((c) => (
              <span key={`${c.kind}:${c.id}`} className="flex max-w-[220px] items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[12.5px] text-subtext">
                {c.kind === "feed" ? <Rss size={10} /> : c.kind === "compost" ? <Recycle size={10} /> : <FileText size={10} />}
                <span className="truncate">{c.title ?? c.id}</span>
                <button onClick={() => onRemoveCtx(c)} className="hover:text-red"><X size={10} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea ref={box} value={speech.listening && speech.interim ? `${text} ${speech.interim}` : text} onChange={(e) => setText(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={speech.listening ? "Listening…" : active ? "Drop to add to context" : placeholder}
          className="block max-h-48 min-h-[52px] w-full resize-none border-0 bg-transparent px-3.5 py-2.5 text-[14.5px] shadow-none focus:shadow-none" />
        <div className="flex items-center gap-1 px-2 pb-2">
          {seedMode && (
            <div className="mr-1 flex rounded-md bg-surface p-0.5">
              {([["ask", "Ask", null], ["steer", "Steer", Navigation], ["idea", "New idea", Lightbulb]] as const).map(([m, label, Icon]) => (
                <button key={m} title={label} onClick={() => seedMode.setMode(m)}
                  className={cx("flex h-7 items-center gap-1 rounded px-2 text-[12.5px]", seedMode.mode === m ? "bg-base font-medium text-text shadow-card" : "text-subtext")}>
                  {Icon && <Icon size={11} />}{(!compact || !Icon) && label}
                </button>
              ))}
            </div>
          )}
          {asking && <PlusMenu skill={skill} onSkill={setSkill} onFiles={attach} attaching={attaching} />}
          {chosen && (
            <span className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-full bg-leaf-soft pl-2.5 pr-1.5 text-[13px] font-medium text-leaf-ink">
              <chosen.icon size={12} /><span className="truncate">{chosen.label}</span>
              <button title="Remove skill" aria-label="Remove skill" onClick={() => setSkill("")} className="opacity-60 hover:opacity-100"><X size={12} /></button>
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {(!seedMode || seedMode.mode === "ask") && (
              <ModelPicker model={model} effort={effort} compact={compact} onChange={(m, e) => { setModel(m); setEffort(e); }} />
            )}
            <button title={voice ? "Voice mode on (replies read aloud)" : "Voice mode off"} onClick={() => setVoice((v) => !v)}
              className={cx("flex h-8 w-8 items-center justify-center rounded-md", voice ? "bg-leaf-soft text-leaf-ink" : "text-muted hover:bg-hover")}>
              {voice ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            <button title={speech.listening ? "Stop listening" : "Dictate (try: “new idea …”, “grow”, “stop”)"} onClick={() => (speech.listening ? speech.stop() : speech.start())}
              className={cx("flex h-8 w-8 items-center justify-center rounded-md", speech.listening ? "pulse-leaf bg-red-soft text-red" : "text-muted hover:bg-hover")}>
              {speech.listening ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
            <button title="Send" onClick={() => submit()} disabled={(!text.trim() && !canSendEmpty) || busy}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-leaf text-white hover:bg-leaf-dark disabled:opacity-35"><Send size={13} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Reader({ papers, url, onPick }: { papers: SeedFiles["papers"]; url: string; onPick: (u: string) => void }) {
  const readable = papers.filter((p) => p.pdf);
  const current = url || readable[0]?.url || "";
  const p = papers.find((x) => x.url === current);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2">
        <FileText size={14} className="text-subtext" />
        <select value={current} onChange={(e) => onPick(e.target.value)} className="h-7 min-w-0 flex-1 py-0 text-[13.5px]">
          {!readable.length && <option value="">No readable PDFs yet</option>}
          {readable.map((x) => <option key={x.id} value={x.url}>{x.title}{x.year ? ` (${x.year})` : ""}</option>)}
        </select>
        {current && <a href={current} target="_blank" rel="noreferrer" className="text-[13px] text-leaf-ink hover:underline">Open source</a>}
      </div>
      {current ? (
        <iframe key={current} title={p?.title ?? "paper"} src={`/api/reader?url=${encodeURIComponent(current)}`} className="min-h-0 w-full flex-1 border-0 bg-canvas" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[14px] text-subtext">Papers with a PDF (arXiv, alphaXiv, Hugging Face) open here.</div>
      )}
    </div>
  );
}
