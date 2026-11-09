import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Gauge, Sparkles } from "lucide-react";
import { api } from "../api";
import { modelLabel, modelLogo } from "../voice";
import { Logo } from "./Logo";
import { cx } from "./ui";

type CatalogModel = { id: string; efforts: string[]; note: string };
type CatalogGroup = { id: string; name: string; logo: string; kind: string; models: CatalogModel[] };

const EFFORT_LABEL: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** Chat-style model picker: pick a model, then a reasoning effort when the model supports it. */
export default function ModelPicker({ model, effort, onChange, compact }: {
  model: string; effort: string; onChange: (model: string, effort: string) => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const catalog = useQuery({ queryKey: ["models", "catalog"], queryFn: () => api.get<CatalogGroup[]>("/api/models/catalog") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<any>("/api/settings") });
  const defaultModel: string = settings.data ? (settings.data.models.ideate || settings.data.models.strong) : "";
  const defaultEffort: string = settings.data?.models.effort?.ideate ?? "";
  const active = model || defaultModel;
  const all = (catalog.data ?? []).flatMap((g) => g.models);
  const efforts = all.find((m) => m.id === active)?.efforts ?? [];
  const shownEffort = effort || (!model ? defaultEffort : "");

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);

  const pick = (m: string) => {
    const next = all.find((x) => x.id === (m || defaultModel))?.efforts ?? [];
    onChange(m, next.includes(effort) ? effort : "");
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} title="Model and effort"
        className={cx("flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors",
          open ? "border-leaf/60 bg-leaf-soft/50 text-text" : "border-border-soft text-subtext hover:border-border hover:text-text")}>
        <Logo id={modelLogo(active || "mock")} size={13} />
        {!compact && <span className="max-w-[130px] truncate font-medium">{modelLabel(active).split(" · ").slice(-1)[0]}</span>}
        {shownEffort && !compact && <span className="rounded-full bg-surface px-1.5 text-[11.5px] text-subtext">{EFFORT_LABEL[shownEffort] ?? shownEffort}</span>}
        <ChevronDown size={11} className={cx("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="picker-pop absolute bottom-full right-0 z-30 mb-2 w-[320px] overflow-hidden rounded-2xl border border-border-soft bg-base/95 p-1.5 shadow-pop backdrop-blur-md">
          <div className="max-h-[320px] overflow-auto">
            <Row selected={!model} onClick={() => pick("")} icon={<Sparkles size={14} className="text-leaf" />}
              title="Default" note={defaultModel ? `${modelLabel(defaultModel)} — set in Settings → Models` : "Your Ideate model"} />
            {(catalog.data ?? []).map((g) => (
              <div key={g.id} className="mt-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">
                  {g.logo && <Logo id={g.logo} size={11} />}{g.name}
                </div>
                {g.models.map((m) => (
                  <Row key={m.id} selected={model === m.id} onClick={() => pick(m.id)} icon={<Logo id={modelLogo(m.id)} size={14} />}
                    title={modelLabel(m.id).split(" · ").slice(-1)[0]} note={m.note} />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-1.5 rounded-xl bg-surface p-2">
            <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[12.5px] font-medium"><Gauge size={12} className="text-subtext" />Effort</div>
            {efforts.length ? (
              <div className="flex flex-wrap gap-1">
                {["", ...efforts].map((e) => (
                  <button key={e || "auto"} onClick={() => onChange(model, e)}
                    className={cx("rounded-full px-2.5 py-1 text-[12.5px] transition-colors",
                      effort === e ? "bg-leaf text-white shadow-card" : "bg-base text-subtext hover:text-text")}>
                    {e ? EFFORT_LABEL[e] ?? e : "Auto"}
                  </button>
                ))}
              </div>
            ) : <div className="px-0.5 text-[12.5px] text-muted">This model picks its own depth.</div>}
            {efforts.length > 0 && <div className="mt-1.5 px-0.5 text-[11.5px] text-muted">Higher effort thinks longer — slower, more thorough.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ selected, onClick, icon, title, note }: { selected: boolean; onClick: () => void; icon: React.ReactNode; title: string; note?: string }) {
  return (
    <button onClick={onClick} className={cx("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors", selected ? "bg-leaf-soft/60" : "hover:bg-hover")}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{title}</span>
        {note && <span className="block truncate text-[12px] text-muted">{note}</span>}
      </span>
      {selected && <Check size={14} className="shrink-0 text-leaf" />}
    </button>
  );
}
