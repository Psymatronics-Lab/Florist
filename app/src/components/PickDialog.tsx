import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FileText, Flower2, Image as ImageIcon } from "lucide-react";
import { api } from "../api";
import Mascot from "./character/Mascot";
import { Button, cx, Md, Modal, toast } from "./ui";

interface Adapter { name: string; title: string; destination: string; description: string }

export default function PickDialog({ seedId, open, onClose }: { seedId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const adapters = useQuery({ queryKey: ["adapters"], queryFn: () => api.get<Adapter[]>("/api/adapters"), enabled: open });
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<{ path: string; files: string[] } | null>(null);
  const [file, setFile] = useState("flower.md");
  const [content, setContent] = useState("");
  useEffect(() => { if (adapters.data && !chosen.length) setChosen(adapters.data.map((a) => a.name)); }, [adapters.data]);
  const pick = useMutation({
    mutationFn: () => api.post<{ path: string; files: string[] }>(`/api/seeds/${seedId}/pick`, { adapters: chosen }),
    onSuccess: (r) => { setResult(r); setFile("flower.md"); qc.invalidateQueries({ queryKey: ["seeds"] }); qc.invalidateQueries({ queryKey: ["seed", seedId] }); },
    onError: (e: Error) => toast(e.message, "err"),
  });
  useEffect(() => {
    if (!result || file.endsWith(".svg")) return;
    fetch(`/api/packs/file?path=${encodeURIComponent(result.path)}&name=${encodeURIComponent(file)}`).then((r) => r.text()).then(setContent);
  }, [result, file]);
  const close = () => { setResult(null); onClose(); };
  const url = (f: string) => `/api/packs/file?path=${encodeURIComponent(result!.path)}&name=${encodeURIComponent(f)}`;

  return (
    <Modal open={open} onClose={close} width={result ? 1080 : 560}
      title={<span className="flex items-center gap-2"><Flower2 size={16} className="text-leaf" />{result ? "Flower pack" : "Pick this flower"}</span>}
      footer={result
        ? <><Button onClick={() => { navigator.clipboard.writeText(result.path); toast("Path copied"); }}><Copy size={13} />Copy path</Button><Button kind="primary" onClick={close}>Done</Button></>
        : <><Button onClick={close}>Cancel</Button><Button kind="primary" busy={pick.isPending} disabled={!chosen.length} onClick={() => pick.mutate()}>Pick</Button></>}>
      {!result && !pick.isPending && (
        <>
          <p className="mt-0 text-[14px] text-subtext">Florist writes one folder another person or framework can pick up without redoing the exploration: the brief, machine-readable flower, sources, rejected directions, visuals and smoke checks — plus a rendering for each destination.</p>
          <div className="grid gap-2">
            {adapters.data?.map((a) => (
              <label key={a.name} className={cx("flex cursor-pointer items-start gap-3 rounded-lg border p-3", chosen.includes(a.name) ? "border-leaf bg-leaf-soft/30" : "border-border-soft")}>
                <input type="checkbox" className="mt-1 accent-[var(--leaf)]" checked={chosen.includes(a.name)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, a.name] : chosen.filter((x) => x !== a.name))} />
                <div><div className="text-[14.5px] font-semibold">{a.title}</div><div className="text-[13px] text-subtext">{a.description}</div></div>
              </label>
            ))}
          </div>
        </>
      )}
      {pick.isPending && <div className="flex justify-center py-8"><Mascot mood="working" size={120} label="Writing the handoff…" /></div>}
      {result && (
        <div className="flex h-[60vh] gap-4">
          <div className="w-[260px] shrink-0 overflow-auto">
            <div className="mb-2 break-all text-[12px] text-muted">{result.path}</div>
            {result.files.filter((f) => !f.endsWith(".json") || f === "flower.json").map((f) => (
              <button key={f} onClick={() => setFile(f)} className={cx("flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-[13.5px]", file === f ? "bg-selected font-medium" : "hover:bg-hover")}>
                {f.endsWith(".svg") ? <ImageIcon size={12} className="shrink-0 text-purple" /> : <FileText size={12} className="shrink-0 text-subtext" />}<span className="truncate">{f}</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto rounded-lg border border-border-soft p-4">
            {file.endsWith(".svg") ? <img src={url(file)} className="paper max-w-full" /> :
              file.endsWith(".md") ? <Md>{content}</Md> : <pre className="whitespace-pre-wrap font-mono text-[13px]">{content}</pre>}
          </div>
        </div>
      )}
    </Modal>
  );
}
