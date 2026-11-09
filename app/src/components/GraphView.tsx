import { useMemo, useState } from "react";
import { Background, Controls, Edge, Handle, MarkerType, Node, NodeProps, Position, ReactFlow } from "@xyflow/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { api, Graph, GraphNode } from "../api";
import { humanizeIds } from "./FlowerPanel";
import { Button, Chip, cx, IconButton, Meter, toast } from "./ui";

export const KIND_COLOR: Record<string, string> = {
  seed: "var(--leaf)", technology: "var(--teal)", source: "var(--blue)", direction: "var(--leaf-dark)",
  check: "var(--amber)", smoke: "var(--red)", visual: "var(--purple)", finding: "var(--leaf)",
};
const COL_X: Record<string, number> = { seed: 0, source: 290, direction: 620, check: 920, finding: 1220 };

function FloristNode({ data }: NodeProps) {
  const n = data.node as GraphNode;
  const pruned = n.status === "pruned";
  const top = n.status === "top";
  const compact = n.kind === "source" || n.kind === "technology";
  return (
    <div className={cx("rounded-lg border bg-base text-left shadow-card transition-opacity", pruned && "opacity-35",
      top ? "border-leaf ring-2 ring-leaf/25" : "border-border-soft", data.selected ? "ring-2 ring-blue/40" : "",
      compact ? "w-[220px] px-2.5 py-1.5" : "w-[250px] px-3 py-2")}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-subtext">
          {n.kind === "source" ? n.data.kind ?? "source" : n.kind}{pruned ? " · pruned" : top ? " · top" : ""}
        </span>
        {n.score != null && <span className="ml-auto text-[11.5px] tabular-nums text-muted">{n.score.toFixed(2)}</span>}
      </div>
      <div className={cx("mt-0.5 leading-snug", compact ? "line-clamp-2 text-[12.5px]" : "line-clamp-3 text-[13.5px] font-medium")}>{n.title}</div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  );
}
const nodeTypes = { florist: FloristNode };

export default function GraphView({ graph }: { graph: Graph }) {
  const titles = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.title] as [string, string])), [graph]);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showPruned, setShowPruned] = useState(true);

  const { nodes, edges } = useMemo(() => {
    const visible = graph.nodes.filter((n) => (showSources || (n.kind !== "source" && n.kind !== "technology")) && (showPruned || n.status !== "pruned"));
    const ids = new Set(visible.map((n) => n.id));
    const of = (k: string) => visible.filter((n) => n.kind === k);
    const out: Node[] = [];
    const place = (n: GraphNode, x: number, y: number) =>
      out.push({ id: n.id, type: "florist", position: { x, y }, data: { node: n, selected: selected?.id === n.id }, draggable: true });

    // directions (best first); each direction's checks sit beside it
    const dirs = of("direction").sort((a, b) => (a.status === "pruned" ? 1 : 0) - (b.status === "pruned" ? 1 : 0) || (b.score ?? 0) - (a.score ?? 0));
    const checksBy = new Map<string, GraphNode[]>();
    of("check").forEach((c) => checksBy.set(c.parents[0], [...(checksBy.get(c.parents[0]) ?? []), c]));
    let y = 0;
    const dirY = new Map<string, number>();
    for (const d of dirs) {
      dirY.set(d.id, y);
      place(d, COL_X.direction, y);
      (checksBy.get(d.id) ?? []).forEach((c, i) => place(c, COL_X.check, y + i * 78));
      y += Math.max(1, (checksBy.get(d.id) ?? []).length) * 78 + 22;
    }
    const mid = y / 2 - 40;
    // seed at the vertical middle; sources/technologies to its right
    of("seed").forEach((n) => place(n, COL_X.seed, mid));
    const srcs = [...of("technology"), ...of("source").sort((a, b) => (b.score ?? 0) - (a.score ?? 0))];
    srcs.forEach((n, i) => place(n, COL_X.source, mid - (srcs.length * 60) / 2 + i * 60));
    // smoke checks + visuals next to their parent direction when possible
    const extra = [...of("smoke"), ...of("visual")];
    extra.forEach((n, i) => place(n, COL_X.finding, dirY.get(n.parents[0]) ?? (y + i * 78)));
    const findings = of("finding");
    findings.forEach((n, i) => place(n, COL_X.finding + 340, mid - (findings.length * 90) / 2 + i * 90));
    // nudge apart nodes that landed on the same spot
    const seen = new Map<string, number>();
    for (const n of out) {
      const k = `${n.position.x}:${Math.round(n.position.y)}`;
      const c = seen.get(k) ?? 0;
      seen.set(k, c + 1);
      n.position.y += c * 78;
    }
    const es: Edge[] = graph.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)).map((e) => ({
      id: `${e.src}-${e.dst}-${e.kind}`, source: e.src, target: e.dst, type: "default",
      animated: false,
      style: { stroke: e.kind === "closest" ? "var(--amber)" : e.kind === "evidence" ? "var(--leaf)" : "var(--border)", strokeWidth: e.kind === "grew" ? 1 : 1.3, opacity: e.kind === "closest" ? 0.55 : 0.8, strokeDasharray: e.kind === "inspired" ? "4 3" : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "var(--muted)" },
    }));
    return { nodes: out, edges: es };
  }, [graph, showSources, showPruned, selected]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    graph.nodes.forEach((n) => (c[n.kind] = (c[n.kind] ?? 0) + 1));
    return c;
  }, [graph]);

  return (
    <div className="relative h-full w-full">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.1}
        onNodeClick={(_, n) => setSelected((n.data as any).node)} onPaneClick={() => setSelected(null)} proOptions={{ hideAttribution: true }}>
        <Background gap={22} size={1} color="var(--border-soft)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-soft bg-base/95 px-3 py-1.5 text-[12.5px] shadow-card">
        {Object.entries(counts).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1 text-subtext"><span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[k] }} />{k} {v}</span>
        ))}
        <span className="mx-1 h-3 w-px bg-border" />
        <label className="flex items-center gap-1"><input type="checkbox" checked={showSources} onChange={(e) => setShowSources(e.target.checked)} className="accent-[var(--leaf)]" />sources</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showPruned} onChange={(e) => setShowPruned(e.target.checked)} className="accent-[var(--leaf)]" />pruned</label>
      </div>
      {selected && <NodePanel node={selected} titles={titles} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function NodePanel({ node, onClose, titles }: { node: GraphNode; onClose: () => void; titles: Map<string, string> }) {
  const h = (t: string) => humanizeIds(t, titles);
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (v: { action: string; note?: string }) => api.post(`/api/nodes/${node.id}/action`, v),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["seed", node.seed_id] }); toast(`${v.action}: ${node.title}`); onClose(); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  const s = node.data.scores;
  const chk = node.data.check;
  return (
    <div className="absolute bottom-3 right-3 top-3 z-10 flex w-[360px] flex-col overflow-hidden rounded-xl border border-border-soft bg-base shadow-pop">
      <div className="flex items-start justify-between gap-2 border-b border-border-soft px-4 py-3">
        <div>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em]" style={{ color: KIND_COLOR[node.kind] }}>
            {node.kind}{node.status !== "active" ? ` · ${node.status}` : ""} · round {node.round}
          </div>
          <div className="mt-0.5 text-[15px] font-semibold leading-snug">{node.title}</div>
        </div>
        <IconButton title="Close" onClick={onClose}><X size={14} /></IconButton>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3 text-[14px]">
        {node.url && <a href={node.url} target="_blank" rel="noreferrer" className="mb-2 flex items-center gap-1 truncate text-[13px] text-leaf-ink hover:underline"><ExternalLink size={11} />{node.url}</a>}
        {node.kind === "source" && (
          <div className="mb-2 flex flex-wrap gap-1 text-[12.5px] text-subtext">
            {node.data.year && <Chip>{node.data.year}</Chip>}{node.data.venue && <Chip>{node.data.venue}</Chip>}
            {node.data.tool && <Chip>via {node.data.tool}</Chip>}{node.data.citations != null && <Chip>{node.data.citations} cites</Chip>}
            {node.data.stars != null && <Chip>★ {node.data.stars}</Chip>}
          </div>
        )}
        {node.data.description && <p className="mt-0">{node.data.description}</p>}
        {!node.data.description && node.summary && <p className="mt-0 text-subtext">{node.summary}</p>}
        {node.kind === "source" && node.data.abstract && <p className="text-[13px] text-subtext">{String(node.data.abstract).slice(0, 700)}</p>}
        {node.reason && <div className={cx("mb-2 rounded-md px-2.5 py-1.5 text-[13.5px]", node.status === "pruned" ? "bg-surface text-subtext" : "bg-leaf-soft text-leaf-ink")}>{node.status === "pruned" ? "Pruned: " : ""}{h(node.reason)}</div>}
        {node.data.deepen && <div className="mb-2 text-[13.5px]"><b>Next round digs into:</b> {node.data.deepen}</div>}
        {s && (
          <div className="mb-3 space-y-1.5">
            <Meter label="Novelty" value={s.novelty} color="var(--blue)" />
            <Meter label="Feasibility" value={s.feasibility} color="var(--leaf)" />
            <Meter label="Room" value={1 - s.crowdedness} color="var(--amber)" />
            <Meter label="Interest" value={s.interest} color="var(--purple)" />
            <Meter label="Overall" value={s.overall} color="var(--leaf-dark)" />
            {s.interest_learned != null && <div className="text-[12px] text-muted">interest = model {Number(s.interest_model).toFixed(2)} blended with your learned taste {Number(s.interest_learned).toFixed(2)}</div>}
          </div>
        )}
        {chk?.gap && <p><b>Gap:</b> {h(chk.gap)}</p>}
        {chk?.closest_work?.length > 0 && (
          <div className="mb-2"><b>Closest work</b>
            <ul className="mt-1 pl-4">{chk.closest_work.map((c: any) => <li key={c.ref} className="mb-1"><span className="font-medium">{c.title}</span> — <span className="text-subtext">{c.how_it_differs}</span></li>)}</ul>
          </div>
        )}
        {chk?.feasibility_notes && <p><b>Feasibility:</b> {chk.feasibility_notes}</p>}
        {chk?.risks?.length > 0 && <p><b>Risks:</b> {chk.risks.join("; ")}</p>}
        {node.data.crowd && node.data.crowd.total != null && <p className="text-[13px] text-subtext">Crowdedness: {node.data.crowd.total} works match, {node.data.crowd.recent} since {node.data.crowd.since}.</p>}
        {node.kind === "finding" && node.data.evidence && (
          <ul className="pl-4">{node.data.evidence.map((e: any) => <li key={e.ref} className="text-[13px] text-subtext">{e.ref}: “{e.quote}”</li>)}</ul>
        )}
      </div>
      {node.kind === "direction" && (
        <div className="flex flex-wrap gap-1.5 border-t border-border-soft px-4 py-3">
          {node.status === "pruned"
            ? <Button size="sm" onClick={() => act.mutate({ action: "restore" })}>Restore</Button>
            : <>
              <Button size="sm" kind="primary" onClick={() => act.mutate({ action: "boost" })}>Boost</Button>
              <Button size="sm" onClick={() => { const note = prompt("What should the next round dig into?"); if (note) act.mutate({ action: "deepen", note }); }}>Deepen…</Button>
              <Button size="sm" kind="danger" onClick={() => { const note = prompt("Why prune it? (kept with the branch)") ?? ""; act.mutate({ action: "prune", note }); }}>Prune</Button>
            </>}
        </div>
      )}
    </div>
  );
}
