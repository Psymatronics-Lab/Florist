import { ReactNode, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, X } from "lucide-react";
import type { SeedState, Tier } from "../api";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

type BtnKind = "primary" | "secondary" | "ghost" | "danger";
export function Button({ kind = "secondary", size = "md", className, busy, children, ...rest }:
  { kind?: BtnKind; size?: "sm" | "md"; busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors whitespace-nowrap select-none";
  const sz = size === "sm" ? "h-8 px-3 text-[13.5px]" : "h-9 px-3.5 text-[14px]";
  const k = {
    primary: "bg-leaf text-white hover:bg-leaf-dark shadow-card",
    secondary: "bg-base border border-border hover:bg-hover text-text",
    ghost: "hover:bg-hover text-subtext hover:text-text",
    danger: "border border-border text-red hover:bg-red-soft",
  }[kind];
  return (
    <button className={cx(base, sz, k, className)} disabled={busy || rest.disabled} {...rest}>
      {busy && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function IconButton({ title, className, children, ...rest }: { title: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button title={title} aria-label={title}
      className={cx("inline-flex h-8 w-8 items-center justify-center rounded-md text-subtext hover:bg-hover hover:text-text", className)} {...rest}>
      {children}
    </button>
  );
}

export const TIER_LABEL: Record<Tier, string> = { exploration: "Exploration", personal: "Personal project", formal: "Formal investigation" };
const TIER_STYLE: Record<Tier, string> = {
  exploration: "bg-blue-soft text-blue", personal: "bg-leaf-soft text-leaf-ink", formal: "bg-purple-soft text-purple",
};
export function TierBadge({ tier }: { tier: Tier }) {
  return <span className={cx("rounded-full px-2 py-0.5 text-[12px] font-medium", TIER_STYLE[tier])}>{TIER_LABEL[tier]}</span>;
}

const STATE_STYLE: Record<SeedState, string> = {
  candidate: "text-amber", dormant: "text-subtext", growing: "text-blue", flowering: "text-leaf-ink", picked: "text-purple", composted: "text-muted",
};
export function StateBadge({ state, live }: { state: SeedState; live?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 text-[12.5px] font-medium", STATE_STYLE[state])}>
      <span className={cx("h-1.5 w-1.5 rounded-full bg-current", live && "pulse-leaf")} />
      {live ? "growing…" : state}
    </span>
  );
}

export function Chip({ children, onRemove, tone = "neutral", className }: { children: ReactNode; onRemove?: () => void; tone?: "neutral" | "leaf" | "blue" | "amber"; className?: string }) {
  const t = { neutral: "bg-surface text-subtext border-border-soft", leaf: "bg-leaf-soft text-leaf-ink border-transparent", blue: "bg-blue-soft text-blue border-transparent", amber: "bg-amber-soft text-amber border-transparent" }[tone];
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-[1px] text-[12.5px]", t, className)}>
      <span className="truncate">{children}</span>
      {onRemove && <button onClick={onRemove} className="opacity-60 hover:opacity-100"><X size={11} /></button>}
    </span>
  );
}

export function ChipInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-border bg-base px-1.5 py-1 focus-within:border-leaf">
      {value.map((v) => <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>{v}</Chip>)}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={value.length ? "" : placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        className="min-w-[90px] flex-1 border-none bg-transparent p-0.5 text-[14px] shadow-none focus:shadow-none" />
    </div>
  );
}

export function Modal({ open, onClose, title, children, width = 560, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 p-6 pt-[10vh]" onMouseDown={onClose}>
      <div className="flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-border-soft bg-base shadow-modal"
        style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-soft px-5 py-3">
          <div className="text-[16px] font-semibold">{title}</div>
          <IconButton title="Close" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border-soft px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-lg bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={cx("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13.5px] font-medium",
            value === o.value ? "bg-base text-text shadow-card" : "text-subtext hover:text-text")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-[15px] font-medium">{title}</div>
      {children && <div className="max-w-md text-[14px] text-subtext">{children}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="flex items-center gap-2 p-6 text-subtext"><Loader2 size={15} className="animate-spin" />{label}</div>;
}

export function Meter({ value, color = "var(--leaf)", label }: { value: number; color?: string; label?: string }) {
  return (
    <div className="flex items-center gap-2" title={label ? `${label}: ${value.toFixed(2)}` : undefined}>
      {label && <span className="w-[74px] shrink-0 text-[12.5px] text-subtext">{label}</span>}
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, value * 100)}%`, background: color }} />
      </div>
      <span className="w-8 text-right text-[12px] tabular-nums text-subtext">{value.toFixed(2)}</span>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-border-soft px-8 pb-4 pt-6">
      <div className="min-w-0">
        <h1 className="m-0 text-[21.5px] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <div className="mt-0.5 text-[14px] text-subtext">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mb-6", className)}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-[13px] font-semibold uppercase tracking-[0.06em] text-subtext">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Md({ children }: { children: string }) {
  return <div className="prose-florist"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <div className="mb-1 text-[13.5px] font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[12.5px] text-muted">{hint}</div>}
    </label>
  );
}

export function toast(text: string, tone: "ok" | "err" = "ok") {
  window.dispatchEvent(new CustomEvent("florist-toast", { detail: { text, tone } }));
}

export function Toaster() {
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    const h = (e: Event) => setMsg((e as CustomEvent).detail);
    window.addEventListener("florist-toast", h);
    return () => window.removeEventListener("florist-toast", h);
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div className={cx("fixed bottom-5 left-1/2 z-[60] max-w-[560px] -translate-x-1/2 rounded-lg px-4 py-2 text-[14px] shadow-pop",
      msg.tone === "ok" ? "bg-text text-base" : "bg-red text-white")}>{msg.text}</div>
  );
}
