import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckSquare, Flower2, HelpCircle, Target, ThumbsDown, ThumbsUp } from "lucide-react";
import { api, FlowerResp, Graph, visualUrl, Visual } from "../api";
import Mascot from "./character/Mascot";
import { Chip, cx, Empty, Section, Spinner, toast } from "./ui";

export default function FlowerPanel({ seedId, graph, visuals }: { seedId: string; graph?: Graph; visuals: Visual[] }) {
  const [version, setVersion] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["seed", seedId, "flower", version],
    queryFn: () => api.get<FlowerResp>(`/api/seeds/${seedId}/flower${version ? `?version=${version}` : ""}`),
  });
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (v: { node: string; action: string; note?: string }) => api.post(`/api/nodes/${v.node}/action`, v),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["seed", seedId] }); toast(v.action === "boost" ? "Boosted — next round leans this way" : "Pruned with your reason"); },
  });
  if (q.isLoading) return <Spinner />;
  const f = q.data?.flower;
  if (!f) {
    return <Empty icon={<Mascot mood="idle" size={110} />} title="No flower yet">Grow this seed: Florist grounds it in papers, repos and posts, proposes directions, checks novelty and feasibility against your constraints, draws visuals, and writes the flower here.</Empty>;
  }
  const refs = q.data!.refs;
  const titles = new Map<string, string>([...(graph?.nodes ?? []).map((n) => [n.id, n.title] as [string, string]), ...Object.entries(refs).map(([k, v]) => [k, v.title] as [string, string])]);
  const h = (t: string) => humanizeIds(t, titles);
  const dirNodes = new Map((graph?.nodes ?? []).filter((n) => n.kind === "direction").map((n) => [n.id, n]));
  const concept = visuals.find((v) => v.kind === "concept");
  const landscape = visuals.find((v) => v.kind === "landscape");

  const Cite = ({ r, quote }: { r: string; quote?: string }) => {
    const ref = refs[r];
    const label = ref ? ref.title : r;
    const tone = ref?.kind === "smoke" ? "bg-red-soft text-red" : ref?.kind === "check" ? "bg-amber-soft text-amber" : "bg-blue-soft text-blue";
    return (
      <a href={ref?.url || undefined} target="_blank" rel="noreferrer" title={`${label}${ref?.year ? ` (${ref.year})` : ""}${quote ? `\n“${quote}”` : ""}`}
        className={cx("inline-flex max-w-[260px] items-center rounded px-1.5 py-[1px] text-[12px] no-underline", tone)}>
        <span className="truncate">{label}</span>{ref?.year ? <span className="ml-1 opacity-70">{ref.year}</span> : null}
      </a>
    );
  };

  return (
    <div className="mx-auto max-w-[920px] px-8 py-6">
      <div className="mb-4 flex items-center gap-3">
        <Flower2 className="text-leaf" size={20} />
        <div className="text-[19.5px] font-semibold">Flower v{f.version}</div>
        <span className="text-[13px] text-subtext">round {f.round}</span>
        <StabilityPill value={f.stability} first={f.version === 1} />
        {q.data!.versions.length > 1 && (
          <select value={version ?? f.version} onChange={(e) => setVersion(Number(e.target.value))} className="ml-auto h-7 py-0 text-[13px]">
            {q.data!.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · round {v.round}</option>)}
          </select>
        )}
      </div>
      <p className="mb-6 mt-0 text-[16px] leading-relaxed">{h(f.idea)}</p>

      <Section title="Major findings">
        <ol className="m-0 space-y-3 pl-5">
          {f.findings.map((x, i) => (
            <li key={i} className="pl-1 text-[15px] leading-relaxed">
              {h(x.text)}
              <div className="mt-1 flex flex-wrap gap-1">{x.evidence.map((e) => <Cite key={e.ref} r={e.ref} quote={e.quote} />)}</div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Recommended directions">
        <div className="grid gap-2.5">
          {f.directions.map((d, i) => {
            const n = dirNodes.get(d.node_id);
            const s = n?.data.scores;
            return (
              <div key={i} className={cx("rounded-lg border p-4", i === 0 ? "border-leaf/50 bg-leaf-soft/30" : "border-border-soft")}>
                <div className="flex items-start gap-2">
                  <Target size={15} className="mt-0.5 shrink-0 text-leaf" />
                  <div className="flex-1">
                    <div className="text-[15.5px] font-semibold">{d.title}</div>
                    <p className="m-0 mt-1 text-[14.5px] leading-relaxed">{h(d.pitch)}</p>
                    {d.why_you && <p className="m-0 mt-1.5 text-[13.5px] text-subtext"><b>Why you:</b> {h(d.why_you)}</p>}
                    {s && (
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
                        <Chip tone="blue">novelty {s.novelty.toFixed(2)}</Chip><Chip tone="leaf">feasibility {s.feasibility.toFixed(2)}</Chip>
                        <Chip tone="amber">crowded {s.crowdedness.toFixed(2)}</Chip><Chip>interest {s.interest.toFixed(2)}</Chip>
                      </div>
                    )}
                  </div>
                  {n && (
                    <div className="flex gap-1">
                      <button title="More like this" onClick={() => act.mutate({ node: n.id, action: "boost" })} className="rounded p-1.5 text-subtext hover:bg-leaf-soft hover:text-leaf-ink"><ThumbsUp size={14} /></button>
                      <button title="Prune this direction" onClick={() => { const note = prompt("Why prune it?") ?? ""; act.mutate({ node: n.id, action: "prune", note }); }} className="rounded p-1.5 text-subtext hover:bg-red-soft hover:text-red"><ThumbsDown size={14} /></button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {(concept || landscape) && (
        <Section title="Visuals">
          <div className="grid grid-cols-2 gap-3">
            {[concept, landscape].filter(Boolean).map((v) => (
              <figure key={v!.id} className="m-0 overflow-hidden rounded-lg border border-border-soft">
                <img src={visualUrl(seedId, v!.files.svg)} alt={v!.title} className="paper block w-full" />
                <figcaption className="border-t border-border-soft px-3 py-1.5 text-[12.5px] text-subtext">{v!.title}</figcaption>
              </figure>
            ))}
          </div>
        </Section>
      )}

      <Section title="Novelty evidence">
        {f.novelty.closest_work.length > 0 ? (
          <ul className="m-0 space-y-1.5 pl-5 text-[14.5px]">
            {f.novelty.closest_work.map((c) => <li key={c.ref}><Cite r={c.ref} /> <span className="text-subtext">— {h(c.how_it_differs)}</span></li>)}
          </ul>
        ) : <div className="text-[14px] text-subtext">No close existing work identified in the sources read.</div>}
        {f.novelty.gap && <div className="mt-2 rounded-md bg-leaf-soft px-3 py-2 text-[14.5px] text-leaf-ink"><b>The gap:</b> {h(f.novelty.gap)}</div>}
      </Section>

      <div className="grid grid-cols-2 gap-6">
        <Section title="Risks"><List items={f.risks.map(h)} icon={<AlertTriangle size={13} className="text-amber" />} /></Section>
        <Section title="Open questions"><List items={f.open_questions.map(h)} icon={<HelpCircle size={13} className="text-blue" />} /></Section>
        <Section title="First steps"><List items={f.first_steps.map(h)} icon={<CheckSquare size={13} className="text-leaf" />} ordered /></Section>
        <Section title="Success criteria"><List items={f.success_criteria.map(h)} icon={<Target size={13} className="text-purple" />} /></Section>
      </div>
    </div>
  );
}

function List({ items, icon, ordered }: { items: string[]; icon: React.ReactNode; ordered?: boolean }) {
  if (!items.length) return <div className="text-[14px] text-muted">—</div>;
  return (
    <ul className="m-0 list-none space-y-1.5 p-0">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2 text-[14.5px] leading-snug">
          <span className="mt-[3px] shrink-0">{icon}</span>
          <span>{ordered && <span className="mr-1 text-muted">{i + 1}.</span>}{t}</span>
        </li>
      ))}
    </ul>
  );
}

function StabilityPill({ value, first }: { value: number; first: boolean }) {
  if (first) return <span className="rounded-full bg-surface px-2 py-0.5 text-[12px] text-subtext">first bloom</span>;
  const stable = value >= 0.85;
  return (
    <span title="Similarity to the previous version — the loop stops when the flower is stable"
      className={cx("rounded-full px-2 py-0.5 text-[12px]", stable ? "bg-leaf-soft text-leaf-ink" : "bg-amber-soft text-amber")}>
      {stable ? "stable" : "still changing"} · {value.toFixed(2)}
    </span>
  );
}

/** Replace raw node ids (src_1a2b3c4d …) in model prose with short quoted titles. */
export function humanizeIds(text: string, titles: Map<string, string>): string {
  return (text || "").replace(/((?:src|chk|smk|dir|fnd|tech)_[0-9a-f]{8})/g, (m) => {
    const t = titles.get(m);
    return t ? `“${t.length > 60 ? t.slice(0, 59) + "…" : t}”` : m;
  });
}
