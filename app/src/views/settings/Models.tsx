import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, FlaskConical, KeyRound, Route, Terminal, Wand2, Zap } from "lucide-react";
import { api, Provider } from "../../api";
import { Logo } from "../../components/Logo";
import { Button, cx, Md, Spinner, toast } from "../../components/ui";
import { modelLabel, modelLogo } from "../../voice";
import { Card, SettingsTitle } from "./Settings";

const ROLES = [
  { id: "ideate", label: "Ideate", icon: Wand2, hint: "Chats and brainstorming" },
  { id: "fast", label: "Fast", icon: Zap, hint: "Searching, reading, summarizing" },
  { id: "strong", label: "Strong", icon: FlaskConical, hint: "Critique, ranking, the flower" },
];
const KIND_LABEL: Record<string, string> = { subscription: "Subscription", api: "API key", local: "Local", offline: "Offline" };
const TOOL_LOGO: Record<string, string> = { alphaxiv: "alphaxiv", openalex: "openalex", arxiv: "arxiv", semantic_scholar: "semantic_scholar", agent_web: "claude" };

export default function Models() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<any>("/api/settings") });
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api.get<Provider[]>("/api/providers") });
  const models = useQuery({ queryKey: ["models", "configured"], queryFn: () => api.get<string[]>("/api/models/configured") });
  const catalog = useQuery({ queryKey: ["models", "catalog"], queryFn: () => api.get<{ models: { id: string; efforts: string[] }[] }[]>("/api/models/catalog") });
  const effortsOf = (m: string) => (catalog.data ?? []).flatMap((g) => g.models).find((x) => x.id === m)?.efforts ?? [];
  const put = useMutation({
    mutationFn: (patch: any) => api.put("/api/settings", patch),
    onSuccess: () => ["settings", "models", "status"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  if (!settings.data || !providers.data) return <Spinner />;
  const m = settings.data.models;
  const configured = providers.data.filter((p) => p.configured);
  const others = providers.data.filter((p) => !p.configured);

  return (
    <>
      <SettingsTitle title="Models" sub="Use a subscription you already pay for, an API key, or a local model." />
      <Card title="Roles">
        <div className="grid grid-cols-3 gap-3">
          {ROLES.map(({ id, label, icon: Icon, hint }) => {
            const val = id === "ideate" ? (m.ideate || m.strong) : m[id];
            return (
              <div key={id} className="rounded-lg border border-border-soft p-3">
                <div className="flex items-center gap-1.5 text-[14px] font-semibold"><Icon size={13} className="text-leaf" />{label}</div>
                <div className="mb-2 text-[12.5px] text-subtext">{hint}</div>
                <label className="flex items-center gap-2 rounded-md border border-border px-2">
                  <Logo id={modelLogo(val)} size={14} />
                  <select value={val} onChange={(e) => put.mutate({ models: { [id]: e.target.value, ...(id === "strong" ? { default: e.target.value } : {}) } })}
                    className="h-8 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13.5px] shadow-none focus:shadow-none">
                    {(models.data ?? [val]).map((x) => <option key={x} value={x}>{modelLabel(x)}</option>)}
                  </select>
                </label>
                <div className="mt-2 flex items-center gap-1.5 text-[12.5px]">
                  <span className="text-subtext">Effort</span>
                  {effortsOf(val).length ? (
                    <select value={m.effort?.[id] ?? ""} onChange={(e) => put.mutate({ models: { effort: { ...m.effort, [id]: e.target.value } } })}
                      className="h-6 flex-1 rounded-full px-2 py-0 text-[12.5px]">
                      <option value="">Auto</option>
                      {effortsOf(val).map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  ) : <span className="text-muted">model decides</span>}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mb-0 mt-3 text-[12.5px] text-muted">Only models from providers set up below are listed.</p>
      </Card>

      <h2 className="mb-2 mt-0 text-[15px] font-semibold">Providers</h2>
      <div className="mb-6 grid grid-cols-2 gap-3">
        {[...configured, ...others].map((p) => <ProviderCard key={p.id} p={p} />)}
      </div>

      <Card title="Research loop & skills" icon={<Route size={15} />}>
        <div className="mb-4">
          <div className="mb-1.5 text-[13.5px] font-medium">Paper search order <span className="font-normal text-muted">— falls back to the next one on errors or rate limits</span></div>
          <div className="flex flex-wrap items-center gap-1.5">
            {settings.data.research_order.map((t: string, i: number, arr: string[]) => (
              <span key={t} className="flex items-center gap-1.5">
                <span className="flex items-center gap-1.5 rounded-full border border-border-soft px-2.5 py-1 text-[13px]">
                  <Logo id={TOOL_LOGO[t] ?? t} size={13} />{t.replace("_", " ")}
                  {i > 0 && <button title="Move earlier" className="text-muted hover:text-text"
                    onClick={() => { const o = [...arr]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; put.mutate({ research_order: o }); }}>‹</button>}
                </span>
                {i < arr.length - 1 && <span className="text-muted">→</span>}
              </span>
            ))}
          </div>
        </div>
        <div className="mb-4 flex flex-wrap gap-5 text-[14px]">
          <label className="flex items-center gap-2"><input type="checkbox" checked={settings.data.smoke_enabled} onChange={(e) => put.mutate({ smoke_enabled: e.target.checked })} className="accent-[var(--leaf)]" />Propose smoke checks (you approve each run)</label>
          <label className="flex items-center gap-2">Cache searches for
            <select value={settings.data.cache_ttl_days} onChange={(e) => put.mutate({ cache_ttl_days: Number(e.target.value) })} className="h-7 px-1.5 py-0 text-[13.5px]">
              {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select></label>
        </div>
        <SkillList />
      </Card>
    </>
  );
}

function ProviderCard({ p }: { p: Provider }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: () => api.post("/api/settings/keys", { provider: p.id, key }),
    onSuccess: () => { setKey(""); ["providers", "models", "settings"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`${p.name} key saved`); },
  });
  const test = useMutation({
    mutationFn: () => api.get<{ ready: boolean; detail: string }>(`/api/models/check?model=${encodeURIComponent(p.models[0] ?? p.id)}`),
    onSuccess: (r) => toast(r.detail, r.ready ? "ok" : "err"),
  });
  return (
    <div className={cx("rounded-xl border", p.configured ? "border-leaf/40" : "border-border-soft")}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface"><Logo id={p.logo} size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14.5px] font-semibold">{p.name}<span className="rounded bg-surface px-1.5 text-[11.5px] font-normal text-subtext">{KIND_LABEL[p.kind]}</span></div>
          <div className={cx("flex items-center gap-1 text-[12.5px]", p.configured ? "text-leaf-ink" : "text-muted")}>
            {p.configured ? <Check size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-border" />}{p.detail}
          </div>
        </div>
        {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
      </button>
      {open && (
        <div className="border-t border-border-soft px-4 py-3 text-[13.5px]">
          {p.note && <p className="mb-2 mt-0 text-subtext">{p.note}</p>}
          {p.kind === "api" && (
            <>
              <div className="flex gap-1.5">
                <div className="relative flex-1"><KeyRound size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.key_env} className="h-8 w-full pl-7 text-[13.5px]" /></div>
                <Button size="sm" kind="primary" disabled={!key} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
              </div>
              {p.keys_url && <a href={p.keys_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-leaf-ink hover:underline">Get a key<ExternalLink size={11} /></a>}
            </>
          )}
          {p.setup && (
            <div className="flex flex-col gap-1">
              {p.setup.map((c) => (
                <div key={c} className="flex items-center gap-2 rounded-md bg-surface px-2.5 py-1.5 font-mono text-[13px]">
                  <Terminal size={11} className="text-muted" /><span className="flex-1">{c}</span>
                  <button title="Copy" onClick={() => { navigator.clipboard.writeText(c.split("   #")[0]); toast("Copied"); }} className="text-muted hover:text-text"><Copy size={11} /></button>
                </div>
              ))}
            </div>
          )}
          {p.models.length > 0 && <div className="mt-2 text-[12.5px] text-muted">Models: {p.models.map(modelLabel).join(" · ")}</div>}
          {p.kind !== "offline" && <Button size="sm" className="mt-2" busy={test.isPending} onClick={() => test.mutate()}>Check</Button>}
        </div>
      )}
    </div>
  );
}

function SkillList() {
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api.get<{ name: string; description: string; agent: boolean }[]>("/api/skills") });
  const [open, setOpen] = useState<string | null>(null);
  const body = useQuery({ queryKey: ["skill", open], queryFn: () => api.get<{ text: string }>(`/api/skills/${open}`), enabled: !!open });
  return (
    <div>
      <div className="mb-1.5 text-[13.5px] font-medium">Skills <span className="font-normal text-muted">— the prompt and rubric for each step; edit the files in skills/</span></div>
      <div className="divide-y divide-border-soft rounded-lg border border-border-soft">
        {skills.data?.map((s) => (
          <div key={s.name}>
            <button onClick={() => setOpen(open === s.name ? null : s.name)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] hover:bg-hover">
              {open === s.name ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="w-40 shrink-0 font-mono text-[13px]">{s.name.replace("florist-", "")}</span>
              <span className="truncate text-subtext">{s.description.replace(/ Returns \w+\.?$/, "")}</span>
            </button>
            {open === s.name && <div className="max-h-80 overflow-auto border-t border-border-soft bg-canvas px-5 py-3 text-[13.5px]">{body.data ? <Md>{body.data.text}</Md> : <Spinner />}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
