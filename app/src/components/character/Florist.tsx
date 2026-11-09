/**
 * The Florist — a layered 2D character (after the "Florist character design" sheet).
 *
 * Every part is its own SVG group, nested three deep so motions compose like a Live2D rig:
 *   parallax (follows the pointer, per-part depth) → pose (springs between gestures) → loop (idle motion).
 * Hair, hat, eyes, head and hands move independently; the hat and hair lag behind the head
 * (follow-through), and pose changes squash-and-stretch.
 *
 * Moods: idle · wave · thinking · reading · searching · working (watering, side profile) · happy ·
 * surprised · confused · sleep.
 */
import { useEffect, useId, useRef, useState } from "react";
import "./florist.css";

export type Mood = "idle" | "wave" | "thinking" | "reading" | "searching" | "working" | "happy" | "surprised" | "confused" | "sleep";
const FIDGETS = ["glance", "hat", "hop", "wave", "stretch"] as const;
type Fidget = (typeof FIDGETS)[number] | "";

const SIDE_MOODS: Mood[] = ["working"];
const HAND_DROP = 6;

export default function FloristCharacter({ mood = "idle", size = 120, track = true, className, title }: {
  mood?: Mood; size?: number; track?: boolean; className?: string; title?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const clip = `flc-hatclip-${useId().replace(/:/g, "")}`;
  const [blink, setBlink] = useState(false);
  const [fidget, setFidget] = useState<Fidget>("");
  const [pop, setPop] = useState(0);

  // squash-and-stretch whenever the mood changes
  useEffect(() => { setPop((k) => k + 1); setFidget(""); }, [mood]);

  // natural, irregular blinking
  useEffect(() => {
    if (mood === "sleep" || mood === "happy") return;
    let t: number;
    const loop = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 170);
        if (Math.random() < 0.25) window.setTimeout(() => { setBlink(true); window.setTimeout(() => setBlink(false), 150); }, 320);
        loop();
      }, 2200 + Math.random() * 3800);
    };
    loop();
    return () => window.clearTimeout(t);
  }, [mood]);

  // idle fidgets: glance around, adjust the hat, a little hop, a wave, a stretch
  useEffect(() => {
    if (mood !== "idle") return;
    let t: number;
    const loop = () => {
      t = window.setTimeout(() => {
        setFidget(FIDGETS[Math.floor(Math.random() * FIDGETS.length)]);
        window.setTimeout(() => setFidget(""), 1700);
        loop();
      }, 5500 + Math.random() * 6500);
    };
    loop();
    return () => window.clearTimeout(t);
  }, [mood]);

  // pointer parallax: parts shift by depth toward the cursor
  useEffect(() => {
    if (!track) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / Math.max(240, window.innerWidth / 2);
        const dy = (e.clientY - (r.top + r.height * 0.35)) / Math.max(240, window.innerHeight / 2);
        el.style.setProperty("--lx", Math.max(-1, Math.min(1, dx)).toFixed(3));
        el.style.setProperty("--ly", Math.max(-1, Math.min(1, dy)).toFixed(3));
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => { window.removeEventListener("pointermove", onMove); cancelAnimationFrame(raf); };
  }, [track]);

  const view = SIDE_MOODS.includes(mood) ? "side" : "front";
  const eyes = eyeShape(mood);

  return (
    <svg ref={ref} viewBox="0 0 200 200" width={size} height={size} className={`flc ${className ?? ""}`} role="img"
      aria-label={title ?? `Florist (${mood})`} data-mood={mood} data-view={view} data-fidget={fidget} data-blink={blink ? "1" : "0"} data-pop={pop % 2 ? "a" : "b"}>
      <defs>
        {/* keeps the hat crown above the brim line — no bulge below it */}
        <clipPath id={clip}><polygon points="0,85.3 0,0 200,0 200,12.5" /></clipPath>
      </defs>
      <g className="flc-pop">
        <g className="flc-root">
          {/* ground shadow */}
          <ellipse className="flc-shadow" cx="86" cy="183" rx="38" ry="4" />

          {/* hair (behind everything) */}
          <g transform="translate(0 16)"><g className="flc-px flc-px-hair"><g className="flc-pose-hair"><g className="flc-hair">
            <path d="M63 54 Q60 38 85 37 Q109 38 109 55 L113 121 Q113 130 104 130 H63 Q54 130 55 121 Z" className="c-dark" />
          </g></g></g></g>

          {/* body */}
          <g className="flc-px flc-px-body"><g className="flc-body">
            <path d="M73 120 Q73 115 78 115 H93 Q98 115 98 120 C100 146 110 162 122 172 Q125 181 116 181 H55 Q46 181 49 172 C61 162 71 146 73 120 Z" className="c-mid" />
            <path d="M74 128 Q86 132 97 128" className="flc-seam" />
          </g></g>

          {/* head */}
          <g transform="translate(0 16)"><g className="flc-px flc-px-head"><g className="flc-pose-head"><g className="flc-head">
            <g className="flc-face-shift">
              <circle cx="86" cy="64" r="24.5" className="c-mid" />
              <g className="flc-px flc-px-eyes"><g className="flc-look"><g className="flc-eyes">
                <g className="flc-eye flc-eye-l">{eyes(71.5, 56.5)}</g>
                <g className="flc-eye flc-eye-r">{eyes(95, 61)}</g>
              </g></g></g>
              <g className="flc-mouth">{mouth(mood)}</g>
            </g>
            {/* hat: lags behind the head */}
            <g className="flc-px flc-px-hat"><g className="flc-pose-hat"><g className="flc-hat"><g transform="translate(0 -6)">
              <ellipse cx="81" cy="47" rx="28" ry="21" transform="rotate(-14 81 47)" className="c-dark" clipPath={`url(#${clip})`} />
              <path d="M54 56 Q80 47 107 39" className="flc-band" />
              <g transform="translate(101 41)"><g className="flc-hat-flower">
                <circle cx="0" cy="-3.2" r="2.7" className="c-light" /><circle cx="3.2" cy="0" r="2.7" className="c-light" />
                <circle cx="0" cy="3.2" r="2.7" className="c-light" /><circle cx="-3.2" cy="0" r="2.7" className="c-light" />
                <circle cx="0" cy="0" r="1.8" className="c-cream" />
              </g></g>
              <ellipse cx="86" cy="54" rx="64" ry="6.4" transform="rotate(-20 86 54)" className="c-dark" />
            </g></g></g></g>
          </g></g></g></g>

          {/* props that live in the scene */}
          {mood === "working" && <WateringScene />}
          <g transform={`translate(0 ${HAND_DROP})`}>{mood === "reading" && <Book />}</g>
          <g transform="translate(0 8)">
            {mood === "thinking" && <ThoughtBubble />}
            {mood === "sleep" && <Zzz />}
            {mood === "confused" && <Confused />}
            {mood === "surprised" && <Exclaim />}
          </g>
          {mood === "happy" && <Sparkles />}

          {/* hands (in front) */}
          <g transform={`translate(0 ${HAND_DROP})`}>
            <g className="flc-px flc-px-hands"><g className="flc-pose-hand-l"><g className="flc-hand-l">
              <circle cx="40" cy="141" r="9.6" className="c-mid" />
            </g></g></g>
            <g className="flc-px flc-px-hands"><g className="flc-pose-hand-r"><g className="flc-hand-r">
              {mood === "searching" && <Magnifier />}
              <circle cx="131" cy="141" r="9.6" className="c-mid" />
            </g></g></g>
          </g>
        </g>
      </g>
    </svg>
  );
}

function eyeShape(mood: Mood) {
  return (cx: number, cy: number) => {
    if (mood === "happy") return <path d={`M${cx - 4.5} ${cy + 1.5} Q${cx} ${cy - 4.5} ${cx + 4.5} ${cy + 1.5}`} className="flc-stroke" />;
    if (mood === "sleep") return <path d={`M${cx - 4.2} ${cy} Q${cx} ${cy + 3.6} ${cx + 4.2} ${cy}`} className="flc-stroke" />;
    const r = mood === "surprised" ? 6.6 : mood === "confused" ? 4.3 : 5.3;
    return <g className="flc-eyeball"><circle cx={cx} cy={cy} r={r} className="c-dark" /></g>;
  };
}

function mouth(mood: Mood) {
  switch (mood) {
    case "happy": case "wave":
      return <path d="M79.5 74.5 Q85 82.5 90.5 74.5 Z" className="c-dark flc-mouth-open" />;
    case "surprised":
      return <ellipse cx="85" cy="77.5" rx="2.6" ry="3.3" className="c-dark" />;
    case "thinking": case "searching":
      return <path d="M81 77.5 L88 76.5" className="flc-stroke flc-stroke-thin" />;
    case "confused":
      return <path d="M79.5 78 q2.2 -2.4 4.4 0 t4.4 0" className="flc-stroke flc-stroke-thin" />;
    case "sleep":
      return <circle cx="85" cy="77.5" r="1.7" className="c-dark" />;
    case "reading": case "working":
      return <path d="M81.5 75.5 Q85 78.5 88.5 75.5" className="flc-stroke flc-stroke-thin" />;
    default:
      return <path d="M80.5 74.5 L85 78.8 L89.5 74.5" className="flc-stroke flc-stroke-thin" />;
  }
}

function WateringScene() {
  return (
    <g>
      <g className="flc-sprout">
        <path d="M172 183 V164" className="flc-stem" />
        <path d="M172 171 C163 171 160 165 161 161 C167 161 172 165 172 171 Z" className="c-mid" />
        <path d="M172 166 C181 166 184 160 183 156 C177 156 172 160 172 166 Z" className="c-light" />
      </g>
      <g transform={`translate(0 ${HAND_DROP})`}><g className="flc-can">
        <path d="M138 110 H158 L155 130 H141 Z" className="c-dark" />
        <path d="M158 115 L172 106" className="flc-spout" />
        <rect x="169" y="102.5" width="7" height="5" rx="1.5" transform="rotate(-34 172 105)" className="c-dark" />
        <path d="M142 110 Q148 99 154 110" className="flc-handle" />
        <circle className="flc-drop d1" cx="176" cy="112" r="1.8" />
        <circle className="flc-drop d2" cx="174" cy="114" r="1.6" />
        <circle className="flc-drop d3" cx="178" cy="113" r="1.5" />
      </g></g>
    </g>
  );
}

function Book() {
  return (
    <g className="flc-book">
      <path d="M60 128 Q73 123 86 129 V151 Q73 145 60 150 Z" className="c-cream flc-page" />
      <path d="M112 128 Q99 123 86 129 V151 Q99 145 112 150 Z" className="c-cream flc-page" />
      <path d="M86 129 V151" className="flc-spine" />
      {[0, 1, 2, 3].map((i) => <path key={i} d={`M65 ${133 + i * 4} Q73 ${130 + i * 4} 81 ${134 + i * 4}`} className="flc-lines" />)}
      {[0, 1, 2, 3].map((i) => <path key={`r${i}`} d={`M91 ${134 + i * 4} Q99 ${130 + i * 4} 107 ${133 + i * 4}`} className="flc-lines" />)}
      <path className="flc-flip" d="M86 129 Q99 124 112 128 V150 Q99 145 86 151 Z" />
    </g>
  );
}

function Magnifier() {
  return (
    <g className="flc-magnifier">
      <path d="M131 141 L141 127" className="flc-handle-thick" />
      <circle cx="146" cy="120" r="9" className="flc-lens" />
    </g>
  );
}

function ThoughtBubble() {
  return (
    <g className="flc-bubble">
      <circle cx="118" cy="38" r="2.6" className="c-cream flc-b1" />
      <circle cx="126" cy="29" r="3.8" className="c-cream flc-b2" />
      <rect x="130" y="6" width="44" height="22" rx="11" className="c-cream flc-b3" />
      <circle cx="142" cy="17" r="2.3" className="c-dark flc-dot flc-dot1" />
      <circle cx="152" cy="17" r="2.3" className="c-dark flc-dot flc-dot2" />
      <circle cx="162" cy="17" r="2.3" className="c-dark flc-dot flc-dot3" />
    </g>
  );
}

function Sparkles() {
  const star = (x: number, y: number, s: number, cls: string) => (
    <g key={cls} transform={`translate(${x} ${y}) scale(${s})`}>
      <path className={`flc-spark ${cls}`} d="M0 -6 C0.8 -1.2 1.2 -0.8 6 0 C1.2 0.8 0.8 1.2 0 6 C-0.8 1.2 -1.2 0.8 -6 0 C-1.2 -0.8 -0.8 -1.2 0 -6 Z" />
    </g>
  );
  return <g>{star(30, 70, 1, "s1")}{star(146, 58, 1.2, "s2")}{star(150, 120, 0.8, "s3")}{star(22, 118, 0.9, "s4")}{star(118, 18, 0.7, "s5")}</g>;
}

function Zzz() {
  return (
    <g className="flc-zzz">
      <text x="116" y="40" className="flc-z z1">z</text>
      <text x="126" y="28" className="flc-z z2">z</text>
      <text x="138" y="16" className="flc-z z3">Z</text>
    </g>
  );
}

function Confused() {
  return (
    <g>
      <text x="118" y="34" className="flc-q">?</text>
      <path className="flc-sweat" d="M108 47 C108 47 104 53 104 55.5 A4 4 0 0 0 112 55.5 C112 53 108 47 108 47 Z" />
    </g>
  );
}

function Exclaim() {
  return (
    <g className="flc-exclaim">
      <path d="M120 22 L124 34" className="flc-burst" /><path d="M131 26 L127 36" className="flc-burst" /><path d="M138 34 L130 40" className="flc-burst" />
    </g>
  );
}
