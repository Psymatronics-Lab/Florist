import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Pencil } from "lucide-react";
import { Button, cx, Md } from "./ui";

/**
 * A single editable markdown document — the way Florist keeps qualitative config (profile,
 * seed spec sheets): paste from anywhere, edit in place. Optional section outline on the left;
 * an optional Florist-owned block (between `begin`/`end` markers) is shown tinted in preview.
 */
export default function MarkdownDoc({ text, onSave, saving, outline = false, owned, minHeight = 360, placeholder, startInPreview = false }: {
  text: string; onSave: (t: string) => void; saving?: boolean; outline?: boolean; startInPreview?: boolean;
  owned?: { begin: string; end: string; label: string }; minHeight?: number; placeholder?: string;
}) {
  const [draft, setDraft] = useState(text);
  const [preview, setPreview] = useState(startInPreview);
  const [active, setActive] = useState(-1);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(text), [text]);
  const dirty = draft !== text;
  const heads = useMemo(() => draft.split("\n").map((l, i) => ({ l, i })).filter(({ l }) => /^#{1,3}\s/.test(l))
    .map(({ l, i }) => ({ line: i, level: l.match(/^#+/)![0].length, title: l.replace(/^#+\s*/, "") })), [draft]);

  const jump = (line: number) => {
    setActive(line);
    if (preview) {
      document.getElementById(`md-h-${line}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const ta = area.current;
    if (!ta) return;
    const pos = draft.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lineH = 21;
    ta.scrollTop = Math.max(0, line * lineH - 40);
  };

  const parts = useMemo(() => {
    if (!owned) return [{ text: draft, owned: false }];
    const b = draft.indexOf(owned.begin), e = draft.indexOf(owned.end);
    if (b < 0 || e < b) return [{ text: draft, owned: false }];
    return [{ text: draft.slice(0, b), owned: false }, { text: draft.slice(b + owned.begin.length, e), owned: true }, { text: draft.slice(e + owned.end.length), owned: false }];
  }, [draft, owned]);

  return (
    <div className="flex overflow-hidden rounded-xl border border-border-soft bg-base">
      {outline && (
        <nav className="w-[170px] shrink-0 border-r border-border-soft bg-canvas py-2">
          <div className="px-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Sections</div>
          {heads.map((h) => (
            <button key={h.line} onClick={() => jump(h.line)} style={{ paddingLeft: 12 + (h.level - 1) * 10 }}
              className={cx("block w-full truncate py-1 pr-2 text-left text-[13.5px]", active === h.line ? "text-leaf-ink" : "text-subtext hover:text-text",
                owned && h.title.toLowerCase().includes(owned.label.toLowerCase()) && "italic")}>
              {h.title}
            </button>
          ))}
        </nav>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-soft px-3 py-1.5">
          <div className="flex rounded-md bg-surface p-0.5">
            <button onClick={() => setPreview(false)} className={cx("flex h-6 items-center gap-1 rounded px-2 text-[13px]", !preview ? "bg-base shadow-card" : "text-subtext")}><Pencil size={11} />Edit</button>
            <button onClick={() => setPreview(true)} className={cx("flex h-6 items-center gap-1 rounded px-2 text-[13px]", preview ? "bg-base shadow-card" : "text-subtext")}><Eye size={11} />Preview</button>
          </div>
          <span className="text-[12.5px] text-muted">{dirty ? "Unsaved changes · Ctrl+S" : "Saved"}</span>
          <Button size="sm" kind={dirty ? "primary" : "secondary"} className="ml-auto" disabled={!dirty} busy={saving} onClick={() => onSave(draft)}>Save</Button>
        </div>
        {preview ? (
          <div className="overflow-auto px-6 py-4" style={{ minHeight, maxHeight: "70vh" }}>
            {parts.map((p, i) => p.owned ? (
              <div key={i} className="my-2 rounded-lg border border-leaf/30 bg-leaf-soft/30 px-4 py-2"><Md>{p.text}</Md></div>
            ) : <HeadingAnchors key={i} text={p.text} offset={draft.indexOf(p.text) >= 0 ? draft.slice(0, draft.indexOf(p.text)).split("\n").length - 1 : 0} />)}
          </div>
        ) : (
          <textarea ref={area} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck placeholder={placeholder}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (dirty) onSave(draft); } }}
            className="block w-full flex-1 resize-y rounded-none border-0 px-5 py-4 font-mono text-[14px] leading-[21px] shadow-none focus:shadow-none"
            style={{ minHeight }} />
        )}
      </div>
    </div>
  );
}

function HeadingAnchors({ text, offset }: { text: string; offset: number }) {
  // Split on headings so the outline can scroll the preview to them.
  const lines = text.split("\n");
  const blocks: { line: number; text: string }[] = [];
  let cur: string[] = [], start = 0;
  lines.forEach((l, i) => {
    if (/^#{1,3}\s/.test(l) && cur.length) { blocks.push({ line: start, text: cur.join("\n") }); cur = []; start = i; }
    cur.push(l);
  });
  if (cur.length) blocks.push({ line: start, text: cur.join("\n") });
  return <>{blocks.map((b) => <div key={b.line} id={`md-h-${offset + b.line}`}><Md>{b.text}</Md></div>)}</>;
}
