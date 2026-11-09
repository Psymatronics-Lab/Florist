import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import Heatmap from "../../components/Heatmap";
import { Logo } from "../../components/Logo";
import { Segmented, Spinner } from "../../components/ui";
import { modelLabel, modelLogo } from "../../voice";
import { Card, SettingsTitle } from "./Settings";

type Metric = "calls" | "tokens" | "usd";
const FMT: Record<Metric, (v: number) => string> = {
  calls: (v) => v.toLocaleString(), tokens: (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${v}`), usd: (v) => `$${v.toFixed(v < 1 ? 3 : 2)}`,
};

export default function Stats() {
  const s = useQuery({ queryKey: ["stats"], queryFn: () => api.get<any>("/api/stats?days=60"), refetchInterval: 30000 });
  const [metric, setMetric] = useState<Metric>("calls");
  if (!s.data) return <Spinner />;
  const t = s.data.total, c = s.data.counts;
  const tiles: [string, string][] = [
    ["Model calls", FMT.calls(t.calls ?? 0)], ["Tokens", FMT.tokens(t.tokens ?? 0)], ["Spend", FMT.usd(t.usd ?? 0)],
    ["Sources read", (c.sources_read ?? 0).toLocaleString()], ["Flowers", `${c.flowers}`], ["Packs picked", `${c.packs}`],
  ];
  return (
    <>
      <SettingsTitle title="Statistics" sub="What Florist did and what it cost. Subscription costs are the CLI's reported list price." />
      <div className="mb-6 grid grid-cols-6 gap-3">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-border-soft px-4 py-3">
            <div className="text-[12.5px] text-subtext">{k}</div>
            <div className="mt-0.5 text-[24px] font-semibold tabular-nums tracking-[-0.01em]">{v}</div>
          </div>
        ))}
      </div>
      <Card title="Last 60 days" right={<Segmented value={metric} onChange={setMetric} options={[{ value: "calls", label: "Calls" }, { value: "tokens", label: "Tokens" }, { value: "usd", label: "Spend" }]} />}>
        <Bars series={s.data.series} metric={metric} />
      </Card>
      <Card title="Activity"><Heatmap days={s.data.heatmap} label="events" /></Card>
      <div className="grid grid-cols-2 gap-6">
        <Card title="By model">
          <Breakdown rows={s.data.by_model.map((r: any) => ({ key: r.key, label: modelLabel(r.key), icon: <Logo id={modelLogo(r.key)} size={13} />, v: r.usd || 0, sub: `${r.calls} calls` }))} fmt={FMT.usd} />
        </Card>
        <Card title="By step">
          <Breakdown rows={s.data.by_step.map((r: any) => ({ key: r.key, label: r.key.replace("_", " "), v: r.calls, sub: FMT.usd(r.usd || 0) }))} fmt={FMT.calls} />
        </Card>
      </div>
      {s.data.by_seed.length > 0 && (
        <Card title="By seed">
          <Breakdown rows={s.data.by_seed.map((r: any) => ({ key: r.key, label: r.title, v: r.usd || 0, sub: `${r.calls} calls` }))} fmt={FMT.usd} />
        </Card>
      )}
    </>
  );
}

/** Single-series daily bars: thin marks, rounded data-ends, 2px gaps, recessive grid, hover tooltip. */
function Bars({ series, metric }: { series: any[]; metric: Metric }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const H = 180, padL = 44, padB = 22, padT = 8;
  const vals = series.map((d) => Number(d[metric]) || 0);
  const max = Math.max(...vals, metric === "usd" ? 0.01 : 1);
  const nice = niceMax(max);
  const plotW = Math.max(100, w - padL - 4);
  const bw = plotW / series.length;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / nice);
  const ticks = [0, nice / 2, nice];
  return (
    <div ref={ref} className="relative">
      <svg width={w} height={H} role="img" aria-label={`${metric} per day`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" />
            <text x={padL - 8} y={y(t) + 4} fontSize={10.5} textAnchor="end" fill="var(--muted)">{FMT[metric](t)}</text>
          </g>
        ))}
        {series.map((d, i) => {
          const v = vals[i];
          const x = padL + i * bw + 1, bh = Math.max(0, y(0) - y(v)), width = Math.max(1, bw - 2);
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * bw} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              {v > 0 && <path d={roundTop(x, y(v), width, bh, Math.min(4, width / 2))} fill={hover === i ? "var(--leaf-dark)" : "var(--leaf)"} />}
            </g>
          );
        })}
        {series.map((d, i) => (i % 10 === 0 ? <text key={d.date} x={padL + i * bw + bw / 2} y={H - 6} fontSize={10.5} textAnchor="middle" fill="var(--muted)">
          {new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text> : null))}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute rounded-md bg-text px-2 py-1 text-[12.5px] text-base shadow-pop"
          style={{ left: Math.min(padL + hover * bw, w - 150), top: Math.max(0, y(vals[hover]) - 34) }}>
          <b>{FMT[metric](vals[hover])}</b> · {new Date(series[hover].date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          {series[hover].failed ? <span> · {series[hover].failed} failed</span> : null}
        </div>
      )}
    </div>
  );
}

function roundTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= r) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v;
}

function Breakdown({ rows, fmt }: { rows: { key: string; label: string; icon?: React.ReactNode; v: number; sub?: string }[]; fmt: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.v), 1e-9);
  if (!rows.length) return <div className="text-[13.5px] text-muted">No data yet.</div>;
  return (
    <div className="flex flex-col gap-2">
      {rows.slice(0, 8).map((r) => (
        <div key={r.key} className="text-[13.5px]" title={`${r.label}: ${fmt(r.v)}${r.sub ? ` · ${r.sub}` : ""}`}>
          <div className="mb-0.5 flex items-center gap-1.5">{r.icon}<span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="tabular-nums text-text">{fmt(r.v)}</span>{r.sub && <span className="w-20 text-right text-[12px] text-muted">{r.sub}</span>}</div>
          <div className="h-1.5 rounded-full bg-surface"><div className="h-full rounded-full bg-leaf" style={{ width: `${Math.max(2, (r.v / max) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
