import { useMemo, useState } from "react";

/** GitHub-style activity heatmap: one hue (Florist green), light → dark, weeks as columns. */
const STEPS = ["var(--surface)", "color-mix(in oklab, var(--leaf) 28%, var(--base))", "color-mix(in oklab, var(--leaf) 52%, var(--base))",
  "color-mix(in oklab, var(--leaf) 76%, var(--base))", "var(--leaf-dark)"];

export default function Heatmap({ days, label = "activities", cell = 11 }: { days: { date: string; count: number }[]; label?: string; cell?: number }) {
  const [hover, setHover] = useState<{ x: number; y: number; d: { date: string; count: number } } | null>(null);
  const { weeks, max, total } = useMemo(() => {
    const first = days.length ? new Date(days[0].date + "T00:00:00") : new Date();
    const pad = (first.getDay() + 6) % 7; // Monday-first columns
    const cells = [...Array(pad).fill(null), ...days];
    const w: ({ date: string; count: number } | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7));
    return { weeks: w, max: Math.max(1, ...days.map((d) => d.count)), total: days.reduce((a, d) => a + d.count, 0) };
  }, [days]);
  const level = (c: number) => (c <= 0 ? 0 : Math.min(4, 1 + Math.floor((c / max) * 3.999)));
  const gap = 3;
  const months: { x: number; label: string }[] = [];
  weeks.forEach((w, i) => {
    const d = w.find(Boolean);
    if (d && new Date(d.date + "T00:00:00").getDate() <= 7) months.push({ x: i * (cell + gap), label: new Date(d.date + "T00:00:00").toLocaleString(undefined, { month: "short" }) });
  });
  const width = weeks.length * (cell + gap);
  return (
    <div className="relative">
      <svg width={width} height={7 * (cell + gap) + 16} role="img" aria-label={`${total} ${label} in the last ${days.length} days`}>
        {months.map((m) => <text key={m.x} x={m.x} y={10} fontSize={10} fill="var(--muted)">{m.label}</text>)}
        {weeks.map((w, i) => w.map((d, j) => d && (
          <rect key={d.date} x={i * (cell + gap)} y={16 + j * (cell + gap)} width={cell} height={cell} rx={2.5}
            fill={STEPS[level(d.count)]} stroke={hover?.d.date === d.date ? "var(--text)" : "none"}
            onMouseEnter={() => setHover({ x: i * (cell + gap), y: 16 + j * (cell + gap), d })} onMouseLeave={() => setHover(null)} />
        )))}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-text px-2 py-1 text-[12.5px] text-base shadow-pop"
          style={{ left: Math.min(hover.x, width - 150), top: hover.y - 30 }}>
          <b>{hover.d.count}</b> {label} · {new Date(hover.d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 text-[12px] text-muted">
        <span>{total} {label}</span><span className="ml-auto">Less</span>
        {STEPS.map((c, i) => <span key={i} className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />)}<span>More</span>
      </div>
    </div>
  );
}
