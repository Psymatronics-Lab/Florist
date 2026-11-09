import { ReactNode } from "react";
import { Funnel } from "lucide-react";
import { Button, cx, Modal } from "./ui";

/** One funnel opens every filter: choices stay out of sight until they are wanted. */
export function FilterButton({ active, onClick }: { active: number; onClick: () => void }) {
  return (
    <button onClick={onClick} title="Filters" aria-label={active ? `Filters, ${active} active` : "Filters"}
      className={cx("relative flex h-8 w-8 items-center justify-center rounded-md border transition-colors",
        active ? "border-leaf/60 bg-leaf-soft/50 text-leaf-ink" : "border-border text-subtext hover:bg-hover hover:text-text")}>
      <Funnel size={14} />
      {active > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-leaf px-1 text-[11px] font-semibold text-white">{active}</span>}
    </button>
  );
}

export function FilterModal({ open, onClose, onReset, width = 560, children }: {
  open: boolean; onClose: () => void; onReset: () => void; width?: number; children: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} width={width} title={<span className="flex items-center gap-2"><Funnel size={15} className="text-leaf" />Filters</span>}
      footer={<><Button kind="ghost" className="mr-auto" onClick={onReset}>Reset</Button><Button kind="primary" onClick={onClose}>Done</Button></>}>
      <div className="flex flex-col gap-5">{children}</div>
    </Modal>
  );
}

export function FilterGroup({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-[13px] font-semibold text-subtext">{title}</h3>
        {right}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </section>
  );
}

export function FilterPill({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon?: ReactNode; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={cx("flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-[13.5px] transition-colors",
        on ? "border-leaf bg-leaf-soft text-leaf-ink" : "border-border-soft text-subtext hover:border-border hover:text-text")}>
      {icon}<span className="truncate">{children}</span>
    </button>
  );
}
