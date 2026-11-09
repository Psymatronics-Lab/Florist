/**
 * Brand logos in color — sources, research tools and model providers. Simple Icons (CC0) for most
 * marks; alphaXiv and OpenAI marks from OpenResearch's MIT-licensed assets. Near-black brand colors
 * render in the current text color so they stay visible in dark mode.
 */
import {
  siAnthropic, siArxiv, siBluesky, siClaude, siDeepseek, siGithub, siGmail, siGooglegemini, siHuggingface,
  siHackster, siLobsters, siLmstudio, siMastodon, siMedium, siMeta, siMistralai, siOllama, siOpenrouter, siReddit, siRss,
  siSemanticscholar, siSubstack, siX, siYcombinator, siYoutube,
} from "simple-icons";
import { Dna, FileText, Folder, Globe, Link2, Mail, Presentation, Recycle, Sparkles } from "lucide-react";
import { ALPHAXIV_SHAPES, ALPHAXIV_VIEWBOX, OPENAI_PATHS, OPENAI_VIEWBOX } from "./brandPaths";

type SimpleIcon = { path: string; hex: string; title: string };

const SIMPLE: Record<string, SimpleIcon> = {
  arxiv: siArxiv, github: siGithub, hn: siYcombinator, ycombinator: siYcombinator, hackernews: siYcombinator,
  reddit: siReddit, youtube: siYoutube, bluesky: siBluesky, mastodon: siMastodon, huggingface: siHuggingface,
  hf_papers: siHuggingface, hf_hub: siHuggingface, twitter: siX, medium: siMedium, hackster: siHackster, rss: siRss, gmail: siGmail, anthropic: siAnthropic, claude: siClaude,
  "claude-code": siClaude, meta: siMeta, meta_llama: siMeta, gemini: siGooglegemini, ollama: siOllama,
  openrouter: siOpenrouter, lobsters: siLobsters, substack: siSubstack, semantic_scholar: siSemanticscholar,
  mistral: siMistralai, deepseek: siDeepseek, lmstudio: siLmstudio, lm_studio: siLmstudio,
};

const DARK_INKS = new Set(["000000", "181717", "191919", "171717", "1F2328"]);

export const BRAND_NAME: Record<string, string> = {
  alphaxiv: "alphaXiv", arxiv: "arXiv", hf_papers: "Hugging Face", github: "GitHub", hn: "Hacker News",
  reddit: "Reddit", lobsters: "Lobsters", bluesky: "Bluesky", mastodon: "Mastodon", youtube: "YouTube",
  rss: "RSS", email: "Newsletter", folder: "Notes folder", manual: "Saved link", openalex: "OpenAlex",
  semantic_scholar: "Semantic Scholar", agent_web: "Web (agent)", hackernews: "Hacker News", compost: "Compost",
  hf_hub: "Hugging Face", twitter: "X", medium: "Medium", hackster: "Hackster.io", biorxiv: "bioRxiv", conference: "Conferences",
};

export function Logo({ id, size = 16, className, title }: { id: string; size?: number; className?: string; title?: string }) {
  const key = (id || "").toLowerCase();
  const label = title ?? BRAND_NAME[key] ?? id;
  if (key === "alphaxiv") {
    return (
      <svg width={size} height={size} viewBox={ALPHAXIV_VIEWBOX} className={className} role="img" aria-label={label}>
        <title>{label}</title>
        {ALPHAXIV_SHAPES.map(([tag, d], i) => tag === "polygon"
          ? <polygon key={i} points={d} fill="#9a2036" /> : <path key={i} d={d} fill="#9a2036" />)}
      </svg>
    );
  }
  if (key === "openai" || key === "codex") {
    return (
      <svg width={size} height={size} viewBox={OPENAI_VIEWBOX} className={className} role="img" aria-label={label} fill="currentColor">
        <title>{label}</title>
        {OPENAI_PATHS.map((d, i) => <path key={i} d={d} />)}
      </svg>
    );
  }
  if (key === "florist" || key === "mock") {
    return <img src="/florist-icon.png" width={size} height={size} className={className} alt={label} />;
  }
  const si = SIMPLE[key];
  if (si) {
    const fill = DARK_INKS.has(si.hex.toUpperCase()) ? "currentColor" : `#${si.hex}`;
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} role="img" aria-label={label} fill={fill}>
        <title>{label}</title>
        <path d={si.path} />
      </svg>
    );
  }
  const Fallback = { email: Mail, folder: Folder, manual: Link2, openalex: Globe, agent_web: Sparkles, compost: Recycle,
    paper: FileText, web: Globe, biorxiv: Dna, conference: Presentation }[key] ?? Globe;
  const color = { email: "#EA4335", folder: "#C98500", openalex: "#C2410C", compost: "var(--leaf)", biorxiv: "#BD2736", conference: "#3A8DFF" }[key] ?? "var(--subtext)";
  return <Fallback size={size} className={className} color={color} aria-label={label} />;
}

/** Feed items: prefer a more specific logo from the URL (Substack, YouTube…) over the source kind. */
export function feedLogoId(kind: string, url = ""): string {
  const u = url.toLowerCase();
  if (u.includes("substack.com")) return "substack";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("github.com")) return kind === "github" ? "github" : kind === "manual" ? "github" : kind;
  if (u.includes("arxiv.org") && kind === "manual") return "arxiv";
  return kind;
}
