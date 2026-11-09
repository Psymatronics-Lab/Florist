import { useEffect, useState } from "react";
import { Sparkles, Sprout } from "lucide-react";
import type { Tier } from "../api";
import { Button, cx, Modal, TierBadge } from "./ui";

export const TIERS: Tier[] = ["exploration", "personal", "formal"];
export const TIER_HINT: Record<Tier, string> = { exploration: "Understand a concept", personal: "Build something", formal: "Publishable research" };

/** Asked at the moment a seed is made. `auto` adds "let Florist decide" (only chats have enough to judge from). */
export default function SeedTypeDialog({ open, onClose, onPick, busy, auto, action = "Plant seed" }: {
  open: boolean; onClose: () => void; onPick: (tier: Tier | "") => void; busy?: boolean; auto?: boolean; action?: string;
}) {
  const first: Tier | "" = auto ? "" : "exploration";
  const [tier, setTier] = useState<Tier | "">(first);
  useEffect(() => { if (open) setTier(first); }, [open, first]);
  const card = (on: boolean) => cx("flex w-full items-center gap-3 rounded-lg border p-3 text-left", on ? "border-leaf bg-leaf-soft/50" : "border-border-soft hover:border-border");
  return (
    <Modal open={open} onClose={onClose} width={440} title={<span className="flex items-center gap-2"><Sprout size={16} className="text-leaf" />What kind of seed?</span>}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={() => onPick(tier)}>{action}</Button></>}>
      <div className="flex flex-col gap-2">
        {auto && (
          <button onClick={() => setTier("")} className={card(tier === "")}>
            <Sparkles size={15} className="shrink-0 text-leaf" />
            <span><span className="block text-[14px] font-medium">Let Florist decide</span><span className="block text-[12.5px] text-subtext">Judged from the conversation</span></span>
          </button>
        )}
        {TIERS.map((t) => (
          <button key={t} onClick={() => setTier(t)} className={card(tier === t)}>
            <TierBadge tier={t} /><span className="text-[12.5px] text-subtext">{TIER_HINT[t]}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
