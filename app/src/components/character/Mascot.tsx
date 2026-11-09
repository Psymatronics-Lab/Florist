/**
 * Mascot: the Florist character when "Character animations" is on (Settings → Profile → Appearance),
 * otherwise the standard chatbot indicators — pulsing dots while thinking, a spinner while working,
 * the static Florist mark in empty states.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "../../api";
import { cx } from "../ui";
import FloristCharacter, { Mood } from "./Florist";

export type { Mood };

export function useCharacterAnimations(): boolean {
  const s = useQuery({ queryKey: ["settings"], queryFn: () => api.get<any>("/api/settings"), staleTime: 60_000 });
  return !!s.data?.ui?.character_animations;
}

const BUSY: Mood[] = ["working", "reading", "searching"];

export default function Mascot({ mood = "idle", size = 96, label, className, force }: {
  mood?: Mood; size?: number; label?: React.ReactNode; className?: string; force?: boolean;
}) {
  const on = useCharacterAnimations() || !!force;
  return (
    <div className={cx("inline-flex flex-col items-center", className)}>
      {on ? <FloristCharacter mood={mood} size={size} /> : <Fallback mood={mood} size={size} />}
      {label && <div className="mt-1 max-w-[220px] text-center text-[13.5px] text-subtext">{label}</div>}
    </div>
  );
}

function Fallback({ mood, size }: { mood: Mood; size: number }) {
  if (mood === "thinking") return <TypingDots />;
  if (BUSY.includes(mood)) return <Loader2 size={Math.max(18, size * 0.24)} className="animate-spin text-leaf" />;
  if (mood === "happy") return <CheckCircle2 size={Math.max(18, size * 0.26)} className="text-leaf" />;
  if (mood === "confused") return <AlertCircle size={Math.max(18, size * 0.26)} className="text-muted" />;
  return <img src="/florist-icon.png" alt="" width={Math.max(20, size * 0.36)} height={Math.max(20, size * 0.36)} className="opacity-80" />;
}

export function TypingDots() {
  return (
    <span className="inline-flex h-6 items-center gap-1 px-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => <span key={i} className="typing-dot h-1.5 w-1.5 rounded-full bg-leaf" style={{ animationDelay: `${i * 0.18}s` }} />)}
    </span>
  );
}
