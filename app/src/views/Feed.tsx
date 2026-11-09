import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dices, ExternalLink, Eye, GripVertical, Link2, MessageCircle, Recycle, RefreshCw, Search, Sparkles, Sprout, X } from "lucide-react";
import { api, FeedItem, relTime, Seed, Source, Tier } from "../api";
import { go } from "../App";
import Mascot from "../components/character/Mascot";
import { Page, PageTitle } from "../components/Layout";
import { FilterButton, FilterGroup, FilterModal, FilterPill } from "../components/Filters";
import { BRAND_NAME, feedLogoId, Logo } from "../components/Logo";
import SeedTypeDialog from "../components/SeedTypeDialog";
import { Button, Chip, cx, Segmented, toast } from "../components/ui";

type View = "all" | "viewed";
type Filters = { sort: "recent" | "relevant"; days: number; cats: string[]; sources: string[] };
const NO_FILTERS: Filters = { sort: "recent", days: 0, cats: [], sources: [] };
const FILTER_KEY = "florist-feed-filters";

const CATEGORIES: { id: string; label: string; kinds: string[] }[] = [
  { id: "papers", label: "Papers", kinds: ["arxiv", "alphaxiv", "hf_papers", "biorxiv"] },
  { id: "conferences", label: "Conferences", kinds: ["conference"] },
  { id: "code", label: "Code", kinds: ["github"] },
  { id: "models", label: "Models & data", kinds: ["hf_hub"] },
  { id: "articles", label: "Articles", kinds: ["rss", "medium", "hackster", "email", "folder"] },
  { id: "discussion", label: "Discussion", kinds: ["hn", "reddit", "lobsters"] },
  { id: "social", label: "Social", kinds: ["twitter", "bluesky", "mastodon"] },
  { id: "video", label: "Video", kinds: ["youtube"] },
  { id: "saved", label: "Saved links", kinds: ["manual"] },
];
const WINDOWS = [{ days: 0, label: "Any time" }, { days: 1, label: "24 hours" }, { days: 3, label: "3 days" }, { days: 7, label: "Week" }, { days: 30, label: "Month" }];

const sourceKey = (i: FeedItem) => i.source_id || "manual";
const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((v) => v !== x) : [...xs, x]);

function loadFilters(): Filters {
  try { return { ...NO_FILTERS, ...JSON.parse(localStorage.getItem(FILTER_KEY) || "{}") }; } catch { return NO_FILTERS; }
}

export default function FeedView() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [filters, setFiltersState] = useState<Filters>(loadFilters);
  const setFilters = (f: Filters) => { setFiltersState(f); try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* private mode */ } };
  const [filtering, setFiltering] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [link, setLink] = useState("");
  const feed = useQuery({
    queryKey: ["feed", view, filters.sort],
    queryFn: () => api.get<FeedItem[]>(`/api/feed?status=new,kept,folded,composted,attached,seeded&limit=500${filters.sort === "recent" ? "&sort=recent" : ""}${view === "viewed" ? "&viewed=true" : ""}`),
  });
  const configured = useQuery({ queryKey: ["sources"], queryFn: () => api.get<Source[]>("/api/sources") });
  const seeds = useQuery({ queryKey: ["seeds"], queryFn: () => api.get<Seed[]>("/api/seeds") });
  const act = useMutation({
    mutationFn: (v: { id: string; action: string; seed_id?: string; tier?: Tier }) => api.post<any>(`/api/feed/${v.id}/action`, v),
    onSuccess: (r, v) => {
      ["feed", "compost", "seeds"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (v.action === "seed") { setSeeding(false); go(`/greenhouse/${r.seed_id}`); }
      else if (v.action !== "open") toast({ compost: "Composted", attach: "Attached to seed", dismiss: "Dismissed — Florist learns from this" }[v.action] ?? "Done");
    },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const markViewed = useMutation({
    mutationFn: (id: string) => api.post(`/api/feed/${id}/action`, { action: "view" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feed"] }),
  });
  const open = (i: FeedItem) => { setSel(i.id); if (!i.viewed_at) markViewed.mutate(i.id); };
  const fetchNow = useMutation({ mutationFn: () => api.post("/api/feed/fetch", { force: true }), onSuccess: () => toast("Pulling sources…") });
  const save = useMutation({
    mutationFn: () => api.post<FeedItem>("/api/feed/link", { url: link }),
    onSuccess: (it) => { setLink(""); qc.invalidateQueries({ queryKey: ["feed"] }); setSel(it.id); toast("Saved"); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const lucky = useMutation({
    mutationFn: () => api.post<{ chat: { id: string }; prompt: string }>("/api/feed/lucky"),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["ideate"] }); go(`/ideate/${r.chat.id}`); toast("Picked something for you — ask Florist what to build with it"); },
    onError: (e: Error) => toast(e.message, "err"),
  });

  const sourceOptions = useMemo(() => {
    const present = new Set((feed.data ?? []).map(sourceKey));
    const opts = (configured.data ?? []).filter((s) => s.enabled || present.has(s.id)).map((s) => ({ id: s.id, name: s.name, logo: s.kind }));
    if (present.has("manual")) opts.push({ id: "manual", name: "Saved links", logo: "manual" });
    return opts.sort((a, b) => a.name.localeCompare(b.name));
  }, [configured.data, feed.data]);
  const rows = useMemo(() => {
    const kinds = new Set(CATEGORIES.filter((c) => filters.cats.includes(c.id)).flatMap((c) => c.kinds));
    const cutoff = filters.days ? Date.now() - filters.days * 86400_000 : 0;
    const needle = q.toLowerCase();
    return (feed.data ?? []).filter((i) => (!kinds.size || kinds.has(i.source_kind))
      && (!filters.sources.length || filters.sources.includes(sourceKey(i)))
      && (!cutoff || new Date(i.published || i.created).getTime() >= cutoff)
      && (!needle || `${i.title} ${i.summary} ${i.tags.join(" ")}`.toLowerCase().includes(needle)));
  }, [feed.data, q, filters]);
  const selected = feed.data?.find((i) => i.id === sel) ?? null;
  const activeFilters = [filters.sort !== "recent", filters.days > 0, filters.cats.length > 0, filters.sources.length > 0].filter(Boolean).length;

  return (
    <Page
      header={<>
        <PageTitle sub={`${rows.length} items`}>Feed</PageTitle>
        <div className="relative ml-4 max-w-[300px] flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search feed" className="h-8 w-full pl-8 text-[14px]" />
        </div>
        <FilterButton active={activeFilters} onClick={() => setFiltering(true)} />
        <div className="ml-auto flex items-center gap-2">
          <Segmented value={view} onChange={setView} options={[{ value: "all", label: "All" }, { value: "viewed", label: "Viewed" }]} />
          <Button size="sm" busy={fetchNow.isPending} onClick={() => fetchNow.mutate()} title="Pull all sources now"><RefreshCw size={13} /></Button>
        </div>
      </>}
      bodyClass="overflow-hidden relative"
      inspector={selected ? <FeedInspector item={selected} seeds={seeds.data ?? []} onSeed={() => setSeeding(true)} onAct={(action, seed_id) => act.mutate({ id: selected.id, action, seed_id })} /> : (
        <div className="flex h-full flex-col gap-3 p-4">
          <form onSubmit={(e) => { e.preventDefault(); link.trim() && save.mutate(); }} className="flex gap-1.5">
            <div className="relative flex-1"><Link2 size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Save a link" className="h-8 w-full pl-7 text-[13.5px]" /></div>
            <Button size="sm" type="submit" busy={save.isPending} disabled={!link.trim()}>Save</Button>
          </form>
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[13.5px] text-muted"><Mascot mood="idle" size={72} />Select an item for the full summary</div>
        </div>
      )}>
      <div className="h-full overflow-auto">
        {feed.data?.length === 0 && view === "all" && (
          <div className="flex flex-col items-center gap-2 py-20 text-center text-[14px] text-subtext">
            <Mascot mood="sleep" size={96} />Nothing here. Pull your sources with <RefreshCw size={12} className="inline" />, or add sources in Settings → Feed.
          </div>
        )}
        {feed.data?.length === 0 && view === "viewed" && <div className="py-20 text-center text-[14px] text-subtext">Items you open show up here.</div>}
        {!!feed.data?.length && !rows.length && <div className="py-20 text-center text-[14px] text-subtext">No items match these filters.</div>}
        <div className="flex flex-col gap-1.5 px-4 py-3">
          {rows.map((i) => <FeedRow key={i.id} item={i} selected={sel === i.id} onSelect={() => open(i)}
            onCompost={() => act.mutate({ id: i.id, action: "compost" })} onOpen={() => act.mutate({ id: i.id, action: "open" })} />)}
        </div>
      </div>
      <button onClick={() => lucky.mutate()} disabled={lucky.isPending}
        className="absolute bottom-5 right-5 flex items-center gap-2 rounded-full border border-border-soft bg-base px-4 py-2 text-[14px] font-medium shadow-pop hover:border-leaf hover:text-leaf-ink">
        <Dices size={15} className={lucky.isPending ? "animate-spin" : ""} />I'm feeling lucky
      </button>
      <FilterModal open={filtering} onClose={() => setFiltering(false)} onReset={() => setFilters(NO_FILTERS)}>
        <FilterGroup title="Sort by">
          <FilterPill on={filters.sort === "recent"} onClick={() => setFilters({ ...filters, sort: "recent" })}>Most recent</FilterPill>
          <FilterPill on={filters.sort === "relevant"} onClick={() => setFilters({ ...filters, sort: "relevant" })}>Most relevant</FilterPill>
        </FilterGroup>
        <FilterGroup title="Published within">
          {WINDOWS.map((w) => <FilterPill key={w.days} on={filters.days === w.days} onClick={() => setFilters({ ...filters, days: w.days })}>{w.label}</FilterPill>)}
        </FilterGroup>
        <FilterGroup title="Category" right={filters.cats.length > 0 && <button className="text-[13px] text-leaf-ink hover:underline" onClick={() => setFilters({ ...filters, cats: [] })}>All</button>}>
          {CATEGORIES.map((c) => <FilterPill key={c.id} on={filters.cats.includes(c.id)} onClick={() => setFilters({ ...filters, cats: toggle(filters.cats, c.id) })}>{c.label}</FilterPill>)}
        </FilterGroup>
        <FilterGroup title="Sources" right={filters.sources.length > 0 && <button className="text-[13px] text-leaf-ink hover:underline" onClick={() => setFilters({ ...filters, sources: [] })}>All</button>}>
          {sourceOptions.map((s) => <FilterPill key={s.id} on={filters.sources.includes(s.id)} icon={<Logo id={s.logo} size={13} />} onClick={() => setFilters({ ...filters, sources: toggle(filters.sources, s.id) })}>{s.name}</FilterPill>)}
          {!sourceOptions.length && <span className="text-[13px] text-muted">No sources turned on yet.</span>}
        </FilterGroup>
      </FilterModal>
      <SeedTypeDialog open={seeding} onClose={() => setSeeding(false)} busy={act.isPending}
        onPick={(tier) => selected && act.mutate({ id: selected.id, action: "seed", tier: tier || undefined })} />
    </Page>
  );
}

function FeedRow({ item, selected, onSelect, onCompost, onOpen }: { item: FeedItem; selected: boolean; onSelect: () => void; onCompost: () => void; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `feed:${item.id}`, data: { type: "feed", item } });
  const handled = ["composted", "attached", "seeded", "dismissed"].includes(item.status);
  return (
    <div ref={setNodeRef} onClick={onSelect} className={cx("rise group flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors", selected ? "border-leaf/50 bg-leaf-soft/40" : "border-border-soft hover:border-border hover:bg-hover", isDragging && "opacity-40")}>
      <span {...listeners} {...attributes} title="Drag into Ideate, a seed, or Compost" onClick={(e) => e.stopPropagation()}
        className="-ml-2 mt-1.5 cursor-grab text-muted opacity-0 group-hover:opacity-100"><GripVertical size={14} /></span>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface" title={BRAND_NAME[item.source_kind] ?? item.source_kind}>
        <Logo id={feedLogoId(item.source_kind, item.url)} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <a href={item.url || undefined} target="_blank" rel="noreferrer" onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className={cx("line-clamp-1 text-[14.5px] hover:underline", item.viewed_at ? "text-subtext" : "font-medium")}>{item.title}</a>
        {(item.summary || item.content) && <p className="m-0 mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-subtext">{item.summary || item.content.slice(0, 220)}</p>}
        <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted">
          {item.viewed_at && <span className="flex items-center gap-1" title="Viewed"><Eye size={11} />Viewed<span className="ml-1">·</span></span>}
          <span>{item.source_name || item.source_kind}</span><span>·</span><span>{relTime(item.published || item.created)}</span>
          {item.tags.slice(0, 3).map((t) => <span key={t} className="truncate rounded bg-surface px-1.5 text-subtext">{t.length > 24 ? t.slice(0, 24) + "…" : t}</span>)}
        </div>
      </div>
      <span className="mt-1 w-9 text-right text-[12px] tabular-nums text-muted" title="Relevance to you">{Math.round(item.score * 100)}</span>
      {handled ? <span className="w-[74px] text-right text-[12.5px] text-muted">{item.status}</span> : (
        <button title="Compost" onClick={(e) => { e.stopPropagation(); onCompost(); }} className="flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-subtext hover:bg-leaf-soft hover:text-leaf-ink">
          <Recycle size={13} />Compost
        </button>
      )}
    </div>
  );
}

function FeedInspector({ item, seeds, onAct, onSeed }: { item: FeedItem; seeds: Seed[]; onAct: (action: string, seed_id?: string) => void; onSeed: () => void }) {
  const [seed, setSeed] = useState("");
  const toIdeate = async () => { const c = await api.post<{ id: string }>("/api/ideate", { title: item.title, context: [{ kind: "feed", id: item.id }] }); go(`/ideate/${c.id}`); };
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-2 flex items-center gap-2 text-[13px] text-subtext"><Logo id={feedLogoId(item.source_kind, item.url)} size={14} />{item.source_name || item.source_kind} · {relTime(item.published || item.created)}</div>
        <a href={item.url} target="_blank" rel="noreferrer" className="text-[16px] font-semibold leading-snug hover:underline">{item.title}</a>
        {item.author && <div className="mt-0.5 text-[13px] text-muted">{item.author}</div>}
        {item.why && <div className="my-3 flex gap-1.5 rounded-md bg-leaf-soft px-2.5 py-2 text-[13.5px] text-leaf-ink"><Sparkles size={13} className="mt-0.5 shrink-0" />{item.why}</div>}
        {item.summary && <p className="text-[14px] leading-relaxed">{item.summary}</p>}
        {item.content && item.content !== item.summary && (
          <details className="text-[13.5px] text-subtext"><summary className="cursor-pointer">Full excerpt</summary><p className="whitespace-pre-wrap">{item.content.slice(0, 2500)}</p></details>
        )}
        <div className="mt-2 flex flex-wrap gap-1">{[...item.tags, ...item.technologies].slice(0, 10).map((t) => <Chip key={t}>{t}</Chip>)}</div>
        {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="mt-3 flex items-center gap-1 truncate text-[13px] text-leaf-ink hover:underline"><ExternalLink size={11} />{item.url.replace(/^https?:\/\//, "").slice(0, 60)}</a>}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border-soft p-3">
        <Button size="sm" kind="primary" onClick={toIdeate}><MessageCircle size={12} />Ideate about it</Button>
        <div className="flex gap-1.5">
          <select value={seed} onChange={(e) => setSeed(e.target.value)} className="h-8 min-w-0 flex-1 py-0 text-[13px]">
            <option value="">Attach to seed…</option>{seeds.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <Button size="sm" disabled={!seed} onClick={() => onAct("attach", seed)}>Attach</Button>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" className="flex-1" onClick={() => onAct("compost")}><Recycle size={12} />Compost</Button>
          <Button size="sm" className="flex-1" onClick={onSeed}><Sprout size={12} />New seed</Button>
          <Button size="sm" kind="ghost" title="Dismiss" onClick={() => onAct("dismiss")}><X size={13} /></Button>
        </div>
      </div>
    </div>
  );
}
