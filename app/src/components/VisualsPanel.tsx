import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Image as ImageIcon } from "lucide-react";
import { api, Smoke, Visual, visualUrl } from "../api";
import { Button, cx, Empty, Section, Segmented, toast } from "./ui";

export default function VisualsPanel({ seedId, visuals, mermaidGraph }: { seedId: string; visuals: Visual[]; mermaidGraph?: string }) {
  const smoke = useQuery({ queryKey: ["seed", seedId, "smoke"], queryFn: () => api.get<Smoke[]>(`/api/seeds/${seedId}/smoke`) });
  const order = ["concept", "landscape", "scores", "smoke", "graph"];
  const sorted = [...visuals].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <div className="mx-auto max-w-[1100px] px-8 py-6">
      {(smoke.data ?? []).some((s) => s.status === "pending") && (
        <Section title="Awaiting your approval">
          <div className="grid gap-2">{smoke.data!.filter((s) => s.status === "pending").map((s) => <SmokeCard key={s.id} s={s} seedId={seedId} />)}</div>
        </Section>
      )}
      {sorted.length === 0 && <Empty icon={<ImageIcon size={28} />} title="No visuals yet">Each round draws a concept explainer, a landscape map, a score chart and the exploration graph.</Empty>}
      <div className="grid gap-5">
        {sorted.map((v) => <VisualCard key={v.id} v={v} seedId={seedId} mermaidGraph={mermaidGraph} />)}
      </div>
      {(smoke.data ?? []).some((s) => s.status !== "pending") && (
        <Section title="Smoke-check history" className="mt-6">
          <div className="grid gap-2">{smoke.data!.filter((s) => s.status !== "pending").map((s) => <SmokeCard key={s.id} s={s} seedId={seedId} />)}</div>
        </Section>
      )}
    </div>
  );
}

function VisualCard({ v, seedId, mermaidGraph }: { v: Visual; seedId: string; mermaidGraph?: string }) {
  const modes = [
    ...(v.files.svg ? [{ value: "svg", label: "Static" }] : []),
    ...(v.files.plotly ? [{ value: "plotly", label: "Interactive" }] : []),
    ...(v.files.mermaid ? [{ value: "mermaid", label: "Mermaid" }] : []),
  ] as { value: string; label: string }[];
  const [mode, setMode] = useState(modes[0]?.value ?? "svg");
  return (
    <figure className="m-0 overflow-hidden rounded-xl border border-border-soft bg-base">
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5">
        <div><div className="text-[15px] font-semibold">{v.title}</div><div className="text-[13px] text-subtext">{v.caption}</div></div>
        {modes.length > 1 && <Segmented value={mode} onChange={setMode} options={modes} />}
      </div>
      <div className="bg-canvas p-3">
        {mode === "svg" && v.files.svg && <img src={visualUrl(seedId, v.files.svg)} alt={v.title} className="paper mx-auto block max-w-full rounded-lg" />}
        {mode === "plotly" && <PlotlyView url={visualUrl(seedId, v.files.plotly)} />}
        {mode === "mermaid" && <MermaidView url={v.kind === "graph" ? undefined : visualUrl(seedId, v.files.mermaid)} code={v.kind === "graph" ? mermaidGraph : undefined} />}
      </div>
    </figure>
  );
}

function MermaidView({ url, code }: { url?: string; code?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const src = code ?? (await (await fetch(url!)).text());
        const mermaid = (await import("mermaid")).default;
        const dark = document.documentElement.dataset.theme === "dark";
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", flowchart: { htmlLabels: true } });
        const { svg } = await mermaid.render(`m${Math.random().toString(36).slice(2)}`, src);
        if (alive && ref.current) ref.current.innerHTML = svg;
      } catch (e) { if (alive) setErr(String(e)); }
    })();
    return () => { alive = false; };
  }, [url, code]);
  return err ? <pre className="text-[13px] text-red">{err}</pre> : <div ref={ref} className="flex justify-center overflow-auto [&_svg]:max-w-full" />;
}

function PlotlyView({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [spec, mod] = await Promise.all([fetch(url).then((r) => r.json()), import("plotly.js-basic-dist-min")]);
      const Plotly: any = (mod as any).default ?? mod;
      const dark = document.documentElement.dataset.theme === "dark";
      if (alive && ref.current) Plotly.newPlot(ref.current, spec.data, { ...spec.layout, font: { color: dark ? "#ddd" : "#222" }, height: 520 }, { responsive: true, displaylogo: false });
    })();
    return () => { alive = false; };
  }, [url]);
  return <div ref={ref} className="h-[520px] w-full" />;
}

function SmokeCard({ s, seedId }: { s: Smoke; seedId: string }) {
  const qc = useQueryClient();
  const [showCode, setShowCode] = useState(false);
  const run = useMutation({
    mutationFn: (approve: boolean) => api.post(`/api/smoke/${s.id}/${approve ? "approve" : "reject"}`),
    onSuccess: (_, approve) => { qc.invalidateQueries({ queryKey: ["seed", seedId] }); toast(approve ? "Running smoke check locally…" : "Rejected"); },
  });
  const tone = { pending: "border-amber/60 bg-amber-soft/40", passed: "border-leaf/40", failed: "border-red/40", running: "border-blue/40", rejected: "opacity-60" }[s.status] ?? "";
  return (
    <div className={cx("rounded-lg border border-border-soft p-3", tone)}>
      <div className="flex items-start gap-2">
        <FlaskConical size={15} className="mt-0.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold">{s.assumption}</div>
          <div className="text-[13px] text-subtext">{s.rationale}{s.expected && <> · expect: {s.expected}</>}</div>
          {s.verdict && <div className="mt-1 text-[13.5px]"><b>{s.status}:</b> {s.verdict}</div>}
        </div>
        <span className="text-[12px] uppercase tracking-wide text-subtext">{s.status}</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => setShowCode((v) => !v)} className="text-[13px] text-subtext hover:text-text">{showCode ? "Hide" : "Review"} code · {s.timeout_s}s limit</button>
        {s.status === "pending" && <>
          <span className="flex-1" />
          <Button size="sm" kind="ghost" onClick={() => run.mutate(false)}>Reject</Button>
          <Button size="sm" kind="primary" onClick={() => run.mutate(true)}>Approve & run</Button>
        </>}
      </div>
      {showCode && <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-surface p-3 font-mono text-[13px]">{s.code}</pre>}
      {showCode && s.stdout && s.status !== "pending" && <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-surface p-2 font-mono text-[12.5px] text-subtext">{s.stdout.slice(-1500)}</pre>}
    </div>
  );
}
