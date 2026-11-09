import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Background, Controls, Handle, Node, NodeProps, Position, ReactFlow } from "@xyflow/react";
import { ExternalLink, GripVertical, MessageCircle, Plus, Search, Sprout, Table2, Trash2, Waypoints } from "lucide-react";
import { api, Cluster, CompostItem, Seed, Tier } from "../api";
import { go } from "../App";
import Mascot from "../components/character/Mascot";
import { Page, PageTitle } from "../components/Layout";
import { Logo } from "../components/Logo";
import SeedTypeDialog from "../components/SeedTypeDialog";
import { Button, Chip, cx, Field, Modal, Segmented, toast } from "../components/ui";

export default function CompostView() {
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ["compost"], queryFn: () => api.get<CompostItem[]>("/api/compost") });
  const seeds = useQuery({ queryKey: ["seeds"], queryFn: () => api.get<Seed[]>("/api/seeds") });
  const [view, setView] = useState<"table" | "graph">("table");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [seedIds, setSeedIds] = useState<string[] | null>(null);
  const seedFrom = useMutation({
    mutationFn: (tier: Tier | "") => api.post<Seed>("/api/compost/seed", { ids: seedIds, tier: tier || "exploration" }),
    onSuccess: (s) => { setPicked(new Set()); setSeedIds(null); qc.invalidateQueries({ queryKey: ["seeds"] }); go(`/greenhouse/${s.id}`); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    return (items.data ?? []).filter((i) => !ql || `${i.title} ${i.summary} ${i.notes} ${i.tags.join(" ")} ${i.cluster}`.toLowerCase().includes(ql));
  }, [items.data, q]);
  const selected = items.data?.find((i) => i.id === sel) ?? null;
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Page
      header={<>
        <PageTitle sub={`${items.data?.length ?? 0} items`}>Compost</PageTitle>
        <div className="relative ml-4 max-w-[340px] flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search compost" className="h-8 w-full pl-8 text-[14px]" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented value={view} onChange={setView} options={[{ value: "table", label: <Table2 size={13} /> }, { value: "graph", label: <Waypoints size={13} /> }]} />
          <Button size="sm" onClick={() => setAdding(true)}><Plus size={13} />Add</Button>
        </div>
      </>}
      bodyClass="overflow-hidden relative"
      inspector={selected ? <CompostInspector item={selected} seeds={seeds.data ?? []} key={selected.id} onClose={() => setSel(null)} onSeed={() => setSeedIds([selected.id])} /> : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13.5px] text-muted"><Mascot mood="idle" size={72} />Select an item to see its details</div>
      )}>
      {items.data?.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-[14px] text-subtext"><Mascot mood="sleep" size={96} />Compost is empty — drag feed items onto “Compost”, or add a link.</div>
      ) : view === "table" ? (
        <div className="h-full overflow-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead className="sticky top-0 z-10 bg-base text-left text-[12.5px] text-subtext">
              <tr className="border-b border-border-soft"><th className="w-14" /><th className="px-2 py-2 font-medium">Title</th><th className="px-2 py-2 font-medium">Tags</th>
                <th className="px-2 py-2 font-medium">Notes</th><th className="w-28 px-2 py-2 font-medium">Theme</th><th className="w-24 px-2 py-2 font-medium">Added</th></tr>
            </thead>
            <tbody>{rows.map((i) => <Row key={i.id} item={i} selected={sel === i.id} picked={picked.has(i.id)} onPick={() => toggle(i.id)} onSelect={() => setSel(i.id)} />)}</tbody>
          </table>
        </div>
      ) : <ClusterGraph items={rows} onSelect={setSel} />}
      {picked.size > 0 && (
        <div className="absolute bottom-5 right-5 flex items-center gap-2 rounded-xl border border-border-soft bg-base px-3 py-2 shadow-pop">
          <span className="text-[13.5px] text-subtext">{picked.size} selected</span>
          <Button size="sm" kind="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          <Button size="sm" kind="primary" onClick={() => setSeedIds([...picked])}><Sprout size={12} />Create seed</Button>
        </div>
      )}
      <AddCompost open={adding} onClose={() => setAdding(false)} />
      <SeedTypeDialog open={!!seedIds} onClose={() => setSeedIds(null)} busy={seedFrom.isPending} onPick={(t) => seedFrom.mutate(t)} />
    </Page>
  );
}

function Row({ item, selected, picked, onPick, onSelect }: { item: CompostItem; selected: boolean; picked: boolean; onPick: () => void; onSelect: () => void }) {
  const qc = useQueryClient();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `cmp:${item.id}`, data: { type: "compost", item } });
  const save = (patch: Partial<CompostItem>) => api.patch(`/api/compost/${item.id}`, patch).then(() => qc.invalidateQueries({ queryKey: ["compost"] }));
  return (
    <tr ref={setNodeRef} onClick={onSelect} className={cx("group border-b border-border-soft align-top", selected ? "bg-leaf-soft/40" : "hover:bg-hover", isDragging && "opacity-40")}>
      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <span {...listeners} {...attributes} title="Drag into Ideate or a seed" className="cursor-grab text-muted opacity-0 group-hover:opacity-100"><GripVertical size={13} /></span>
          <input type="checkbox" checked={picked} onChange={onPick} className="accent-[var(--leaf)]" />
        </div>
      </td>
      <td className="max-w-[280px] px-2 py-1.5"><Cell value={item.title} onSave={(v) => save({ title: v })} bold /></td>
      <td className="max-w-[200px] px-2 py-1.5"><Cell value={item.tags.join(", ")} onSave={(v) => save({ tags: v.split(",").map((x) => x.trim()).filter(Boolean) })} muted /></td>
      <td className="max-w-[300px] px-2 py-1.5"><Cell value={item.notes} placeholder="add a note" onSave={(v) => save({ notes: v })} muted /></td>
      <td className="px-2 py-2 text-[13px] text-subtext">{item.cluster || "—"}</td>
      <td className="px-2 py-2 text-[13px] tabular-nums text-muted">{item.date}</td>
    </tr>
  );
}

/** Inline-editable cell: click to edit, Enter/blur to save, Esc to cancel. */
function Cell({ value, onSave, bold, muted, placeholder }: { value: string; onSave: (v: string) => void; bold?: boolean; muted?: boolean; placeholder?: string }) {
  const [edit, setEdit] = useState<string | null>(null);
  if (edit !== null) {
    return <input autoFocus value={edit} onClick={(e) => e.stopPropagation()} onChange={(e) => setEdit(e.target.value)}
      onBlur={() => { if (edit !== value) onSave(edit); setEdit(null); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEdit(null); }}
      className="h-7 w-full px-1.5 py-0 text-[14px]" />;
  }
  return (
    <div onDoubleClick={(e) => { e.stopPropagation(); setEdit(value); }} title="Double-click to edit"
      className={cx("line-clamp-2 min-h-[22px] cursor-text rounded px-1.5 py-0.5 hover:ring-1 hover:ring-border", bold && "font-medium", muted && "text-[13.5px] text-subtext")}>
      {value || <span className="text-muted">{placeholder ?? "—"}</span>}
    </div>
  );
}

function ClusterNode({ data }: NodeProps) {
  const d = data as any;
  return (
    <div className={cx("rounded-lg border bg-base shadow-card", d.hub ? "border-leaf px-3 py-2 text-[14px] font-semibold text-leaf-ink" : "w-[190px] border-border-soft px-2.5 py-1.5 text-[12.5px]")}>
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <span className="line-clamp-2">{d.label}</span>
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-0 !bg-transparent" />
    </div>
  );
}

function ClusterGraph({ items, onSelect }: { items: CompostItem[]; onSelect: (id: string) => void }) {
  const clusters = useQuery({ queryKey: ["compost", "clusters"], queryFn: () => api.get<Cluster[]>("/api/compost/clusters") });
  const { nodes, edges } = useMemo(() => {
    const visible = new Set(items.map((i) => i.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    const ns: Node[] = [], es: any[] = [];
    const cs = (clusters.data ?? []).filter((c) => c.items.some((i) => visible.has(i)));
    const cols = Math.max(1, Math.ceil(Math.sqrt(cs.length)));
    cs.forEach((c, k) => {
      const cx0 = (k % cols) * 640, cy0 = Math.floor(k / cols) * 520;
      ns.push({ id: c.id, type: "c", position: { x: cx0, y: cy0 }, data: { label: c.label, hub: true } });
      const mem = c.items.filter((i) => visible.has(i));
      mem.forEach((iid, j) => {
        const a = (j / Math.max(1, mem.length)) * Math.PI * 2;
        const r = 170 + (j % 2) * 60;
        ns.push({ id: iid, type: "c", position: { x: cx0 + Math.cos(a) * r, y: cy0 + Math.sin(a) * r * 0.75 }, data: { label: byId.get(iid)?.title } });
        es.push({ id: `${c.id}-${iid}`, source: c.id, target: iid, style: { stroke: "var(--border)" } });
      });
    });
    return { nodes: ns, edges: es };
  }, [clusters.data, items]);
  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ c: ClusterNode }} fitView minZoom={0.1} proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => !(n.data as any).hub && onSelect(n.id)}>
      <Background gap={22} size={1} color="var(--border-soft)" /><Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

function CompostInspector({ item, seeds, onClose, onSeed }: { item: CompostItem; seeds: Seed[]; onClose: () => void; onSeed: () => void }) {
  const qc = useQueryClient();
  const del = useMutation({ mutationFn: () => api.del(`/api/compost/${item.id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["compost"] }); onClose(); } });
  const toIdeate = async () => { const c = await api.post<{ id: string }>("/api/ideate", { title: item.title, context: [{ kind: "compost", id: item.id }] }); go(`/ideate/${c.id}`); };
  const related = seeds.filter((s) => item.related_seed_ids.includes(s.id));
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-1 flex items-center gap-1.5 text-[12.5px] text-subtext"><Logo id={item.origin === "feed" ? "rss" : item.origin === "seed" ? "florist" : "manual"} size={12} />{item.source || item.origin} · {item.date}</div>
        <div className="text-[16px] font-semibold leading-snug">{item.title}</div>
        {item.links.map((l) => <a key={l} href={l} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 truncate text-[13px] text-leaf-ink hover:underline"><ExternalLink size={11} />{l.replace(/^https?:\/\//, "").slice(0, 48)}</a>)}
        {item.summary && <p className="text-[14px] leading-relaxed">{item.summary}</p>}
        {item.takeaways.length > 0 && <ul className="mt-0 pl-4 text-[13.5px] text-subtext">{item.takeaways.map((t) => <li key={t}>{t}</li>)}</ul>}
        {item.why_interesting && <div className="mb-2 rounded-md bg-leaf-soft px-2.5 py-1.5 text-[13.5px] text-leaf-ink">{item.why_interesting}</div>}
        <div className="flex flex-wrap gap-1">{[...item.tags, ...item.technologies].slice(0, 10).map((t) => <Chip key={t}>{t}</Chip>)}</div>
        {related.length > 0 && <div className="mt-3 text-[13px] text-subtext">Linked to {related.map((s) => <button key={s.id} onClick={() => go(`/greenhouse/${s.id}`)} className="mr-1 text-leaf-ink hover:underline">{s.title}</button>)}</div>}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border-soft p-3">
        <Button size="sm" kind="primary" onClick={toIdeate}><MessageCircle size={12} />Ideate about it</Button>
        <Button size="sm" onClick={onSeed}><Sprout size={12} />Start a seed</Button>
        <Button size="sm" kind="ghost" onClick={() => del.mutate()}><Trash2 size={12} />Delete</Button>
      </div>
    </div>
  );
}

function AddCompost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ link: "", note: "" });
  const add = useMutation({
    mutationFn: () => api.post("/api/compost", v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["compost"] }); setV({ link: "", note: "" }); onClose(); toast("Composted"); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  return (
    <Modal open={open} onClose={onClose} title="Add to compost" width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={add.isPending} disabled={!v.link && !v.note} onClick={() => add.mutate()}>Add</Button></>}>
      <Field label="Link"><input autoFocus className="w-full" value={v.link} onChange={(e) => setV({ ...v, link: e.target.value })} placeholder="https://…" /></Field>
      <Field label="Note" hint="Florist writes the summary, takeaways and tags."><textarea rows={3} className="w-full" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
    </Modal>
  );
}
