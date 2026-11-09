import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, relTime, Source } from "../../api";
import { BRAND_NAME, Logo } from "../../components/Logo";
import { Button, cx, Spinner, toast } from "../../components/ui";
import { Card, SettingsTitle } from "./Settings";

type Field = { key: string; label: string; placeholder?: string; options?: [string, string][]; list?: string[]; secret?: boolean; show?: (c: Record<string, string>) => boolean };
type Kind = { kind: string; logo: string; label: string; short?: string; fields: Field[]; defaults?: Record<string, string>; name: (c: Record<string, string>) => string; note?: string };

const VENUES = ["NeurIPS", "ICML", "ICLR", "CVPR", "ICCV", "ECCV", "ACL", "EMNLP", "AAAI", "ICRA", "IROS", "RSS", "CoRL", "HRI", "SIGGRAPH", "KDD"];
const BIO_SUBJECTS = ["all", "bioengineering", "bioinformatics", "biophysics", "cancer_biology", "cell_biology", "genetics", "genomics", "immunology", "microbiology", "molecular_biology", "neuroscience", "synthetic_biology", "systems_biology"];
const TRACK_HF: [string, string][] = [["popular", "Popular"], ["new", "New"]];
const HF_TYPES: [string, string][] = [["models", "Models"], ["datasets", "Datasets"], ["spaces", "Spaces"]];
const GH_MODES: [string, string][] = [["popular", "Popular repos"], ["new", "New repos"], ["releases", "Releases of one repo"]];
const MEDIUM_MODES: [string, string][] = [["tag", "Tag"], ["author", "Author"], ["publication", "Publication"]];
const label = (xs: [string, string][], v: string) => xs.find(([k]) => k === v)?.[1] ?? v;

const KINDS: Kind[] = [
  { kind: "arxiv", logo: "arxiv", label: "arXiv", fields: [{ key: "category", label: "Category", placeholder: "cs.RO" }], name: (c) => `arXiv ${c.category ?? ""}` },
  { kind: "alphaxiv", logo: "alphaxiv", label: "alphaXiv", fields: [{ key: "interval", label: "Trending over", options: [["3 Days", "3 days"], ["7 Days", "7 days"], ["30 Days", "30 days"], ["90 Days", "90 days"]] }], defaults: { interval: "7 Days" }, name: (c) => `alphaXiv trending (${c.interval})` },
  { kind: "biorxiv", logo: "biorxiv", label: "bioRxiv / medRxiv", short: "bioRxiv", defaults: { server: "biorxiv", subject: "all" },
    fields: [{ key: "server", label: "Server", options: [["biorxiv", "bioRxiv"], ["medrxiv", "medRxiv"]] }, { key: "subject", label: "Subject", list: BIO_SUBJECTS, placeholder: "all" }],
    name: (c) => `${c.server === "medrxiv" ? "medRxiv" : "bioRxiv"}: ${(c.subject || "all").replace(/_/g, " ")}` },
  { kind: "conference", logo: "conference", label: "Conferences", fields: [{ key: "venue", label: "Conference", list: VENUES, placeholder: "CoRL" }], name: (c) => `${c.venue ?? ""} proceedings`, note: "Accepted papers and published proceedings." },
  { kind: "hf_papers", logo: "huggingface", label: "Hugging Face papers", short: "HF papers", fields: [], name: () => "Hugging Face daily papers" },
  { kind: "hf_hub", logo: "huggingface", label: "Hugging Face models", short: "HF models", defaults: { repo_type: "models", mode: "popular" },
    fields: [{ key: "repo_type", label: "Type", options: HF_TYPES }, { key: "mode", label: "Track", options: TRACK_HF }, { key: "query", label: "Search (optional)", placeholder: "robotics" }],
    name: (c) => `Hugging Face: ${c.mode} ${label(HF_TYPES, c.repo_type).toLowerCase()}${c.query ? ` (${c.query})` : ""}` },
  { kind: "github", logo: "github", label: "GitHub", defaults: { mode: "popular" },
    fields: [{ key: "mode", label: "Track", options: GH_MODES }, { key: "topic", label: "Topic", placeholder: "robotics", show: (c) => c.mode !== "releases" }, { key: "repo", label: "Repository", placeholder: "owner/name", show: (c) => c.mode === "releases" }],
    name: (c) => c.mode === "releases" ? `GitHub: ${c.repo ?? ""} releases` : `GitHub: ${c.mode} ${c.topic ?? ""} repos` },
  { kind: "hn", logo: "hn", label: "Hacker News", short: "HN", fields: [{ key: "query", label: "Search", placeholder: "LLM" }], name: (c) => `Hacker News: ${c.query ?? ""}` },
  { kind: "reddit", logo: "reddit", label: "Reddit", fields: [{ key: "subreddit", label: "Subreddit", placeholder: "MachineLearning" }], name: (c) => `r/${c.subreddit ?? ""}` },
  { kind: "lobsters", logo: "lobsters", label: "Lobsters", fields: [{ key: "tag", label: "Tag", placeholder: "ai" }], name: (c) => `Lobsters: ${c.tag ?? ""}` },
  { kind: "twitter", logo: "twitter", label: "X (Twitter)", short: "X", fields: [{ key: "handle", label: "Account", placeholder: "karpathy" }, { key: "token", label: "X API bearer token", placeholder: "only needed once", secret: true, show: () => true }],
    name: (c) => `X: @${(c.handle ?? "").replace(/^@/, "")}`, note: "X has no free feed, so this needs a token from an X API plan." },
  { kind: "bluesky", logo: "bluesky", label: "Bluesky", fields: [{ key: "handle", label: "Handle", placeholder: "name.bsky.social" }], name: (c) => `Bluesky: ${c.handle ?? ""}` },
  { kind: "mastodon", logo: "mastodon", label: "Mastodon", fields: [{ key: "account", label: "Account", placeholder: "@user@instance.social" }], name: (c) => `Mastodon: ${c.account ?? ""}` },
  { kind: "youtube", logo: "youtube", label: "YouTube", fields: [{ key: "channel_id", label: "Channel id", placeholder: "UC…" }], name: (c) => `YouTube: ${c.channel_id ?? ""}` },
  { kind: "medium", logo: "medium", label: "Medium", defaults: { mode: "tag" }, fields: [{ key: "mode", label: "Follow", options: MEDIUM_MODES }, { key: "name", label: "Name", placeholder: "robotics" }], name: (c) => `Medium: ${c.name ?? ""}` },
  { kind: "hackster", logo: "hackster", label: "Hackster.io", short: "Hackster", fields: [], name: () => "Hackster.io news" },
  { kind: "rss", logo: "rss", label: "RSS / blog / podcast", short: "RSS", fields: [{ key: "url", label: "Feed URL", placeholder: "https://…/feed" }], name: (c) => (c.url ?? "").replace(/^https?:\/\//, "") },
];

function endpoint(s: Source): string {
  const c = s.config;
  return ({
    alphaxiv: "https://www.alphaxiv.org/", hf_papers: "https://huggingface.co/papers", hackster: "https://www.hackster.io/news",
    hf_hub: `https://huggingface.co/${c.repo_type === "models" ? "models" : c.repo_type ?? "models"}`, twitter: c.handle ? `https://x.com/${String(c.handle).replace(/^@/, "")}` : "",
    medium: c.mode === "tag" ? `https://medium.com/tag/${c.name}` : c.mode === "author" ? `https://medium.com/@${c.name}` : `https://medium.com/${c.name}`,
    biorxiv: `https://www.${c.server ?? "biorxiv"}.org/`, arxiv: c.category ? `https://arxiv.org/list/${c.category}/recent` : "https://arxiv.org",
    github: c.repo ? `https://github.com/${c.repo}/releases` : `https://github.com/topics/${c.topic ?? ""}`, hn: `https://hn.algolia.com/?q=${encodeURIComponent(c.query ?? "")}`,
    reddit: `https://www.reddit.com/r/${c.subreddit}`, youtube: `https://www.youtube.com/channel/${c.channel_id}`, bluesky: `https://bsky.app/profile/${c.handle}`,
    lobsters: `https://lobste.rs/t/${c.tag}`, rss: c.url, mastodon: "",
  } as Record<string, string>)[s.kind] ?? "";
}

export default function FeedSettings() {
  const qc = useQueryClient();
  const src = useQuery({ queryKey: ["sources"], queryFn: () => api.get<Source[]>("/api/sources") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<any>("/api/settings") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sources"] });
  const add = useMutation({ mutationFn: (b: any) => api.post("/api/sources", b), onSuccess: () => { refresh(); toast("Source added"); } });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/sources/${id}`), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (s: Source) => api.post("/api/sources", { ...s, enabled: !s.enabled }), onSuccess: refresh });
  const pull = useMutation({ mutationFn: (id?: string) => api.post("/api/feed/fetch", { source_id: id, force: true }), onSuccess: () => { toast("Pulling…"); setTimeout(refresh, 4000); } });
  const put = useMutation({ mutationFn: (p: any) => api.put("/api/settings", p), onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }) });
  const [kind, setKind] = useState<Kind>(KINDS[0]);
  const [cfg, setCfg] = useState<Record<string, string>>(KINDS[0].defaults ?? {});
  const visible = kind.fields.filter((f) => !f.show || f.show(cfg));
  const addSource = async () => {
    const { token, ...rest } = cfg;
    if (token) await api.put("/api/settings", { keys: { twitter: token } });
    const config = Object.fromEntries(Object.entries(rest).filter(([k, v]) => v && kind.fields.some((f) => f.key === k && (!f.show || f.show(cfg)))));
    await add.mutateAsync({ kind: kind.kind, name: kind.name(rest), config });
    setCfg(kind.defaults ?? {});
  };
  if (!src.data) return <Spinner />;

  return (
    <>
      <SettingsTitle title="Feed" sub="Where inspiration comes from. Everything lands in one ranked stream." />
      <Card title="Sources" right={<Button size="sm" busy={pull.isPending} onClick={() => pull.mutate(undefined)}><RefreshCw size={12} />Pull all</Button>}>
        <div className="-mx-5 -my-4 divide-y divide-border-soft">
          {src.data.map((s) => {
            const url = endpoint(s);
            return (
              <div key={s.id} className={cx("flex items-center gap-3 px-5 py-2.5", !s.enabled && "opacity-55")}>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface"><Logo id={s.kind === "hn" ? "hn" : s.kind} size={17} /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{s.name}</div>
                  <div className="truncate text-[12.5px] text-subtext">
                    {url ? <a href={url} target="_blank" rel="noreferrer" className="hover:underline">{url.replace(/^https?:\/\//, "")}</a> : Object.values(s.config).join(" · ")}
                    {s.last_error && <span className="text-red"> · {s.last_error.slice(0, 60)}</span>}
                  </div>
                </div>
                <span className="w-20 text-right text-[12.5px] text-muted">{s.last_fetched ? relTime(s.last_fetched) : "never"}</span>
                <button title="Pull now" onClick={() => pull.mutate(s.id)} className="rounded-md p-1.5 text-subtext hover:bg-hover"><RefreshCw size={13} /></button>
                <label className="relative inline-flex cursor-pointer items-center" title={s.enabled ? "Active" : "Paused"}>
                  <input type="checkbox" checked={s.enabled} onChange={() => toggle.mutate(s)} className="peer sr-only" />
                  <span className="h-5 w-9 rounded-full bg-border transition peer-checked:bg-leaf" />
                  <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
                </label>
                <button title="Remove" onClick={() => del.mutate(s.id)} className="rounded-md p-1.5 text-muted hover:text-red"><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Add a source" icon={<Plus size={15} />}>
        <div className="mb-4 grid grid-cols-6 gap-1.5">
          {KINDS.map((k) => (
            <button key={k.kind} title={k.label} onClick={() => { setKind(k); setCfg(k.defaults ?? {}); }}
              className={cx("flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11.5px]", kind.kind === k.kind ? "border-leaf bg-leaf-soft/40" : "border-border-soft hover:border-border")}>
              <Logo id={k.logo} size={18} /><span className="w-full truncate text-center text-subtext">{k.short ?? k.label}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {visible.map((f) => (
            <label key={f.key} className="min-w-[160px] flex-1 text-[13px]"><div className="mb-1 text-subtext">{f.label}</div>
              {f.options ? (
                <select className="h-8 w-full py-0 text-[13.5px]" value={cfg[f.key] ?? ""} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })}>
                  {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) : (
                <input className="h-8 w-full text-[13.5px]" type={f.secret ? "password" : "text"} list={f.list ? `src-${f.key}` : undefined} placeholder={f.placeholder} value={cfg[f.key] ?? ""} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} />
              )}
              {f.list && <datalist id={`src-${f.key}`}>{f.list.map((v) => <option key={v} value={v} />)}</datalist>}
            </label>
          ))}
          <Button kind="primary" busy={add.isPending} disabled={visible.some((f) => !f.options && !f.secret && !f.label.includes("optional") && !cfg[f.key])} onClick={addSource}>Add {BRAND_NAME[kind.kind] ?? kind.label}</Button>
        </div>
        {kind.note && <div className="mt-2 text-[12.5px] text-muted">{kind.note}</div>}
      </Card>

      <Card title="Other">
        <div className="flex flex-wrap items-center gap-6 text-[14px]">
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!settings.data?.auto_fetch_feed} onChange={(e) => put.mutate({ auto_fetch_feed: e.target.checked })} className="accent-[var(--leaf)]" />Pull sources in the background</label>
          <span className="flex items-center gap-2 text-subtext">Save anything else:
            <a href={`javascript:(()=>{fetch('${location.origin}/api/share?url='+encodeURIComponent(location.href)+'&note='+encodeURIComponent(getSelection().toString()),{mode:'no-cors'});alert('Saved to Florist')})()`}
              className="rounded-md border border-leaf bg-leaf-soft px-2.5 py-1 text-[13.5px] font-medium text-leaf-ink no-underline" title="Drag to your bookmarks bar">🌱 Save to Florist</a>
            <span className="text-[12.5px] text-muted">drag to your bookmarks bar</span></span>
        </div>
      </Card>
    </>
  );
}
