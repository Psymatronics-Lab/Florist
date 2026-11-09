import { useEffect, useRef, useState } from "react";

/**
 * Entrance animation (cf. OpenResearch's hyperspace warp): a burst of pollen and petals spirals out
 * of the centre and settles into a slow drift, the four leaves of the Florist mark assemble one by
 * one, and the wordmark rises. ~2.6 s, once per session; click or Esc skips.
 */

const RAMP = 650, BURST = 1200, SETTLE = 900;

type Mote = { a: number; r: number; v: number; spin: number; size: number; petal: boolean; tint: number; drift: number };

function spawn(): Mote {
  return {
    a: Math.random() * Math.PI * 2, r: Math.random() * 0.05, v: 0.25 + Math.random() * 0.9,
    spin: (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 1.2), size: 1 + Math.random() * 3.2,
    petal: Math.random() < 0.35, tint: Math.random(), drift: Math.random() * Math.PI * 2,
  };
}

function speedAt(t: number): number {
  if (t < RAMP) return 0.15 + 1.6 * (t / RAMP) ** 2;
  if (t < BURST) return 1.75;
  const s = Math.min(1, (t - BURST) / SETTLE);
  return 0.06 + 1.69 * (1 - s) ** 3;
}

function Pollen() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const motes = Array.from({ length: 420 }, spawn);
    let w = 0, h = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const root = getComputedStyle(document.documentElement);
    const leaf = root.getPropertyValue("--leaf").trim() || "#00a85a";
    const leafDark = root.getPropertyValue("--leaf-dark").trim() || "#00773a";
    const ink = root.getPropertyValue("--muted").trim() || "#a1a1a1";
    const start = performance.now();
    let last = start, frame = 0;
    const draw = (now: number) => {
      const dt = Math.min(now - last, 50) / 1000;
      last = now;
      const t = now - start;
      const speed = speedAt(t);
      const R = Math.hypot(w, h) / 2;
      ctx.clearRect(0, 0, w, h);
      for (const m of motes) {
        m.r += m.v * speed * dt * 0.55;
        m.a += m.spin * speed * dt * 0.35;
        m.drift += dt;
        if (m.r > 1.05) Object.assign(m, spawn(), { r: 0.02 });
        const x = w / 2 + Math.cos(m.a) * m.r * R + Math.sin(m.drift) * 4 * (1 - speed / 2);
        const y = h / 2 + Math.sin(m.a) * m.r * R + (t > BURST ? (t - BURST) * 0.004 * m.size : 0);
        const alpha = Math.min(1, m.r * 3) * (t > BURST + SETTLE ? 0.55 : 0.9);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = m.tint < 0.55 ? leaf : m.tint < 0.8 ? leafDark : ink;
        if (m.petal) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(m.a + m.drift);
          ctx.beginPath();
          ctx.ellipse(0, 0, m.size * 2.2, m.size, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, m.size * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}

/** The Florist mark as vector leaves (same geometry as florist-icon.png) so it can assemble leaf by leaf. */
const LIGHT = "#00BF63", DARK = "#007A3D";
const LEAVES: { d: string; fill: string; delay: number }[] = [
  { d: "M80 80H135A115 115 0 0 1 250 195V250H195A115 115 0 0 1 80 135Z", fill: LIGHT, delay: 420 },
  { d: "M420 80H365A115 115 0 0 0 250 195V250H305A115 115 0 0 0 420 135Z", fill: LIGHT, delay: 550 },
  { d: "M420 420H365A115 115 0 0 1 250 305V250H305A115 115 0 0 1 420 365Z", fill: LIGHT, delay: 680 },
  { d: "M80 420H135A115 115 0 0 0 250 305V250H195A115 115 0 0 0 80 365Z", fill: DARK, delay: 810 },
  { d: "M344 156H299A49 49 0 0 0 250 205V250H295A49 49 0 0 0 344 205Z", fill: DARK, delay: 980 },
];

export function FloristMark({ size = 96, animate = false }: { size?: number; animate?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="72 72 356 356" role="img" aria-label="Florist" style={{ overflow: "visible" }}>
      {LEAVES.map((l) => (
        <path key={l.d} d={l.d} fill={l.fill} className={animate ? "fl-petal" : undefined} style={animate ? { animationDelay: `${l.delay}ms` } : undefined} />
      ))}
    </svg>
  );
}

export default function Intro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    const leave = window.setTimeout(() => setLeaving(true), reduced ? 500 : 2350);
    const done = window.setTimeout(onDone, reduced ? 800 : 2850);
    const skip = (e: KeyboardEvent) => e.key === "Escape" && onDone();
    window.addEventListener("keydown", skip);
    return () => { clearTimeout(leave); clearTimeout(done); window.removeEventListener("keydown", skip); };
  }, [onDone, reduced]);
  return (
    <div onClick={onDone} className={`fl-intro fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center bg-base ${leaving ? "fl-intro-out" : ""}`}>
      {!reduced && <Pollen />}
      <div className="relative flex flex-col items-center gap-5">
        <FloristMark size={112} animate={!reduced} />
        <div className="flex text-[44px] font-semibold tracking-[-0.03em]" aria-label="Florist">
          {"Florist".split("").map((ch, i) => (
            <span key={i} className={reduced ? "" : "fl-char"} style={{ animationDelay: `${1150 + i * 45}ms` }}>{ch}</span>
          ))}
        </div>
        <div className={`text-[15px] text-subtext ${reduced ? "" : "fl-tagline"}`}>grows ideas</div>
      </div>
    </div>
  );
}
