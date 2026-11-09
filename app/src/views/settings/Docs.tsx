import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery } from "@tanstack/react-query";
import { Copy, Terminal } from "lucide-react";
import { api } from "../../api";
import { cx, Spinner, toast } from "../../components/ui";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function clean(text: string) {
  return text.replace(/^---[\s\S]*?---\s*/, "").replace(/<!--[\s\S]*?-->/g, "")
    .split("\n").filter((l) => !/^\s*<\/?(div|img|p|h1|br)\b/i.test(l)).join("\n");
}

export default function Docs() {
  const docs = useQuery({ queryKey: ["docs"], queryFn: () => api.get<{ name: string; title: string }[]>("/api/docs") });
  const [name, setName] = useState("");
  const cur = name || docs.data?.[0]?.name || "";
  const doc = useQuery({ queryKey: ["docs", cur], queryFn: () => api.get<{ text: string }>(`/api/docs/${cur}`), enabled: !!cur });
  const text = useMemo(() => clean(doc.data?.text ?? ""), [doc.data]);
  const toc = useMemo(() => text.split("\n").filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, "")), [text]);

  return (
    <div className="flex h-full">
      <nav className="w-[220px] shrink-0 overflow-auto border-r border-border-soft px-3 py-7">
        <div className="px-2 pb-2 text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">Docs</div>
        {docs.data?.map((d) => (
          <div key={d.name}>
            <button onClick={() => setName(d.name)} className={cx("block w-full rounded-md px-2 py-1.5 text-left text-[14px]", cur === d.name ? "bg-selected font-medium" : "text-subtext hover:bg-hover hover:text-text")}>{d.title}</button>
            {cur === d.name && toc.map((h) => (
              <a key={h} href={`#doc-${slug(h)}`} onClick={(e) => { e.preventDefault(); document.getElementById(`doc-${slug(h)}`)?.scrollIntoView({ behavior: "smooth" }); }}
                className="block truncate py-1 pl-5 pr-2 text-[13px] text-subtext hover:text-text">{h}</a>
            ))}
          </div>
        ))}
      </nav>
      <article className="min-w-0 flex-1 overflow-auto">
        <div className="doc mx-auto max-w-[720px] px-10 py-10">
          {doc.data ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              h2: ({ children }) => <h2 id={`doc-${slug(String(children))}`}>{children}</h2>,
              pre: ({ children }) => <>{children}</>,
              code: ({ className, children }) => {
                const s = String(children).replace(/\n$/, "");
                if (!className && !s.includes("\n")) return <code>{children}</code>;
                return (
                  <div className="my-3 overflow-hidden rounded-lg bg-[#16181a] text-[#e6e6e6]">
                    <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5 text-[12px] text-white/50">
                      <Terminal size={11} />{className?.replace("language-", "") || "terminal"}
                      <button className="ml-auto flex items-center gap-1 hover:text-white" onClick={() => { navigator.clipboard.writeText(s.replace(/^\$ /gm, "")); toast("Copied"); }}><Copy size={11} />Copy</button>
                    </div>
                    <pre className="m-0 overflow-auto px-4 py-3 font-mono text-[13.5px] leading-relaxed">{s.split("\n").map((l, i) => (
                      <div key={i} className={l.trim().startsWith("#") ? "text-white/45" : ""}>{l}</div>
                    ))}</pre>
                  </div>
                );
              },
            }}>{text}</ReactMarkdown>
          ) : <Spinner />}
        </div>
      </article>
    </div>
  );
}
