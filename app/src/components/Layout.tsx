import { ReactNode, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cx } from "./ui";

/** Main column + optional right inspector (the design's three-column layout). */
export function Page({ header, children, inspector, inspectorWidth = 320, bodyClass }: {
  header?: ReactNode; children: ReactNode; inspector?: ReactNode; inspectorWidth?: number; bodyClass?: string;
}) {
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {header && <div className="flex min-h-[56px] items-center gap-3 border-b border-border-soft px-6 py-2.5">{header}</div>}
        <div className={cx("min-h-0 flex-1", bodyClass ?? "overflow-auto")}>{children}</div>
      </div>
      {inspector && (
        <aside className="flex shrink-0 flex-col overflow-hidden border-l border-border-soft bg-canvas" style={{ width: inspectorWidth }}>
          {inspector}
        </aside>
      )}
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <h1 className="m-0 truncate text-[18.5px] font-semibold tracking-[-0.01em]">{children}</h1>
      {sub && <div className="truncate text-[13px] text-subtext">{sub}</div>}
    </div>
  );
}

/** Collapsible inspector section: details stay hidden until asked for. */
export function Fold({ title, icon, count, children, open: initial = true, right }: {
  title: string; icon?: ReactNode; count?: number; children: ReactNode; open?: boolean; right?: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="border-b border-border-soft">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={13} className="text-muted" /> : <ChevronRight size={13} className="text-muted" />}
          {icon && <span className="text-subtext">{icon}</span>}
          <span className="text-[13.5px] font-semibold">{title}</span>
          {count != null && <span className="text-[12px] text-muted">{count}</span>}
        </button>
        {right}
      </div>
      {open && <div className="px-4 pb-3">{children}</div>}
    </section>
  );
}

export function Empty2({ icon, text }: { icon?: ReactNode; text: string }) {
  return <div className="flex items-center gap-2 py-1 text-[13px] text-muted">{icon}{text}</div>;
}
