import { ReactNode, useCallback, useEffect, useState } from "react";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BarChart3, BookOpen, Clock, Cpu, Inbox, Leaf, MessageCircle, Moon, Play, Recycle, Rss, Settings, Sprout, Square, Sun, User } from "lucide-react";
import { api, CtxItem, Profile, Seed, useLiveActivity } from "./api";
import Intro from "./components/Intro";
import { Logo, feedLogoId } from "./components/Logo";
import { cx, toast, Toaster } from "./components/ui";
import IdeateView from "./views/Ideate";
import GreenhouseView from "./views/Greenhouse";
import SeedConfig from "./views/SeedConfig";
import CompostView from "./views/Compost";
import FeedView from "./views/Feed";
import SettingsView from "./views/settings/Settings";

export type Route =
  | { view: "ideate"; id?: string }
  | { view: "seed"; id: string; tab?: string }
  | { view: "greenhouse"; id?: string }
  | { view: "compost" }
  | { view: "feed" }
  | { view: "settings"; tab: string };

function parse(hash: string): Route {
  const [, view, id, tab] = hash.replace(/^#/, "").split("/");
  if (view === "seed" && id) return { view: "seed", id, tab };
  if (view === "greenhouse") return { view: "greenhouse", id };
  if (view === "compost") return { view: "compost" };
  if (view === "feed") return { view: "feed" };
  if (view === "settings") return { view: "settings", tab: id || "profile" };
  return { view: "ideate", id: view === "ideate" ? id : undefined };
}

export function go(path: string) {
  window.location.hash = path.startsWith("#") ? path : `#${path}`;
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const h = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return route;
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("florist-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
    catch { return "light"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("florist-theme", theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

/** Where a dropped item lands when it is dropped onto the open chat's composer. */
export const composerTarget: { current: null | ((item: CtxItem) => void) } = { current: null };

export function itemFromDrag(data: any): CtxItem | null {
  if (!data) return null;
  if (data.type === "feed") return { kind: "feed", id: data.item.id, title: data.item.title };
  if (data.type === "compost") return { kind: "compost", id: data.item.id, title: data.item.title };
  if (data.type === "source") return { kind: "source", id: data.item.id, title: data.item.title };
  return null;
}

let lastMain = "/";

export default function App() {
  const route = useRoute();
  useEffect(() => { if (route.view !== "settings") lastMain = window.location.hash.replace(/^#/, "") || "/"; }, [route]);
  const [theme, toggleTheme] = useTheme();
  const activity = useLiveActivity();
  const qc = useQueryClient();
  const [intro, setIntro] = useState(() => {
    try { return !sessionStorage.getItem("florist-intro"); } catch { return false; }
  });
  const endIntro = useCallback(() => {
    try { sessionStorage.setItem("florist-intro", "1"); } catch { /* ignore */ }
    setIntro(false);
  }, []);
  const seeds = useQuery({ queryKey: ["seeds"], queryFn: () => api.get<Seed[]>("/api/seeds") });
  const [dragging, setDragging] = useState<any>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const refresh = () => ["feed", "compost", "seeds", "ideate"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const drop = useMutation({
    mutationFn: async ({ target, item }: { target: string; item: CtxItem }) => {
      if (target === "drop:composer" && composerTarget.current) return composerTarget.current(item);
      if (target === "drop:ideate") {
        const chat = await api.post<{ id: string }>("/api/ideate", { title: item.title, context: [item] });
        go(`/ideate/${chat.id}`);
        return toast("New Ideate chat with this in context");
      }
      if (target.startsWith("drop:seed:")) {
        await api.post(`/api/seeds/${target.slice(10)}/context`, item);
        return toast("Added to the seed's context");
      }
      if (target === "drop:compost" && item.kind === "feed") {
        await api.post(`/api/feed/${item.id}/action`, { action: "compost" });
        return toast("Composted");
      }
      if (target === "drop:greenhouse") {
        const seed = item.kind === "feed"
          ? await api.post<{ seed_id: string }>(`/api/feed/${item.id}/action`, { action: "seed" }).then((r) => r.seed_id)
          : await api.post<{ id: string }>("/api/compost/seed", { ids: [item.id] }).then((r) => r.id);
        go(`/greenhouse/${seed}`);
        return toast("New seed planted");
      }
    },
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, "err"),
  });
  const onDragStart = (e: DragStartEvent) => setDragging(e.active.data.current ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    const item = itemFromDrag(e.active.data.current);
    setDragging(null);
    const target = e.over?.id?.toString();
    if (item && target) drop.mutate({ target, item });
  };

  const inSettings = route.view === "settings";
  const active = (seeds.data ?? []).filter((s) => !["candidate", "composted"].includes(s.state));
  const dragItem = itemFromDrag(dragging);

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      {intro && <Intro onDone={endIntro} />}
      <div className={cx("flex h-full", !intro && "app-enter")}>
        <aside className="flex w-[232px] shrink-0 flex-col border-r border-border-soft bg-panel">
          <button onClick={() => go("/")} className="flex items-center gap-2.5 px-4 pb-4 pt-4 text-left">
            <img src="/florist-icon.png" alt="" className="h-7 w-7" />
            <span className="text-[17.5px] font-semibold tracking-[-0.01em]">Florist</span>
          </button>
          {inSettings ? (
            <SettingsNav tab={route.tab} />
          ) : (
            <>
              <nav className="px-2">
                <NavItem icon={<MessageCircle size={15} />} label="Ideate" active={route.view === "ideate"} onClick={() => go("/")} drop="drop:ideate" dragging={!!dragItem} />
              </nav>
              <div className="mt-3 flex items-center justify-between px-4 pb-1">
                <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">Seeds</span>
                <button title="New seed" className="text-muted hover:text-text" onClick={() => go("/greenhouse/new")}><Sprout size={13} /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
                {active.map((s) => (
                  <SeedLink key={s.id} seed={s} dragging={!!dragItem}
                    active={(route.view === "seed" && route.id === s.id) || (route.view === "greenhouse" && route.id === s.id)} />
                ))}
                {seeds.isSuccess && !active.length && <div className="px-2.5 py-1 text-[13px] text-muted">No seeds yet</div>}
              </div>
              <nav className="flex flex-col gap-0.5 px-2 pb-2">
                <NavItem icon={<Sprout size={15} />} label="Greenhouse" active={route.view === "greenhouse"} onClick={() => go("/greenhouse")} drop="drop:greenhouse" dragging={!!dragItem} />
                <NavItem icon={<Recycle size={15} />} label="Compost" active={route.view === "compost"} onClick={() => go("/compost")} drop={dragItem?.kind === "feed" ? "drop:compost" : undefined} dragging={!!dragItem} />
                <NavItem icon={<Inbox size={15} />} label="Feed" active={route.view === "feed"} onClick={() => go("/feed")} />
              </nav>
            </>
          )}
          <div className="border-t border-border-soft px-2 py-2">
            {!inSettings && <PassiveMode />}
            <div className="flex items-center gap-1">
              <NavItem icon={<Settings size={15} />} label="Profile & settings" active={inSettings} onClick={() => go("/settings/profile")} />
              <button title="Toggle theme" onClick={toggleTheme} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-subtext hover:bg-hover">
                {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden bg-base">
          {route.view === "ideate" && <IdeateView mode="ideate" id={route.id} activity={activity} />}
          {route.view === "seed" && <IdeateView mode="seed" id={route.id} tab={route.tab} activity={activity} key={route.id} />}
          {route.view === "greenhouse" && (route.id && route.id !== "new" ? <SeedConfig id={route.id} /> : <GreenhouseView openNew={route.id === "new"} />)}
          {route.view === "compost" && <CompostView />}
          {route.view === "feed" && <FeedView />}
          {route.view === "settings" && <SettingsView tab={route.tab} />}
        </main>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragItem && (
          <div className="flex w-[280px] items-center gap-2 rounded-lg border border-leaf bg-base px-3 py-2 shadow-pop">
            {dragging.type === "feed" ? <Logo id={feedLogoId(dragging.item.source_kind, dragging.item.url)} size={14} /> : <Recycle size={14} className="text-leaf" />}
            <span className="truncate text-[13.5px] font-medium">{dragItem.title}</span>
          </div>
        )}
      </DragOverlay>
      <Toaster />
    </DndContext>
  );
}

function NavItem({ icon, label, active, onClick, drop, dragging }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; drop?: string; dragging?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: drop ?? `nav:${label}`, disabled: !drop });
  return (
    <button ref={setNodeRef} onClick={onClick}
      className={cx("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14.5px]",
        active ? "bg-selected font-medium text-text" : "text-subtext hover:bg-hover hover:text-text",
        drop && dragging && "drop-ready", isOver && "drop-over")}>
      {icon}<span className="truncate">{label}</span>
    </button>
  );
}

const STAGE_DOT: Record<string, string> = { seed: "text-muted", growing: "text-blue", flower: "text-leaf" };

function SeedLink({ seed, active, dragging }: { seed: Seed; active: boolean; dragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop:seed:${seed.id}` });
  const live = !!seed.run && seed.run.status === "running";
  return (
    <button ref={setNodeRef} onClick={() => go(`/seed/${seed.id}`)} title={seed.title}
      className={cx("flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left",
        active ? "bg-selected" : "hover:bg-hover", dragging && "drop-ready", isOver && "drop-over")}>
      <Leaf size={12} className={cx("shrink-0", STAGE_DOT[seed.stage?.stage ?? "seed"], live && "pulse-leaf")} />
      <span className={cx("truncate text-[14px]", active && "font-medium")}>{seed.title}</span>
    </button>
  );
}

const MODES = [
  { id: "run", icon: Play, label: "Run", hint: "Grow queued seeds now, whatever the schedule" },
  { id: "scheduled", icon: Clock, label: "Scheduled", hint: "Grow queued seeds during your downtime hours" },
  { id: "stop", icon: Square, label: "Stop", hint: "No background growth" },
] as const;

function PassiveMode() {
  const qc = useQueryClient();
  const p = useQuery({ queryKey: ["profile"], queryFn: () => api.get<Profile>("/api/profile") });
  const set = useMutation({
    mutationFn: (mode: string) => api.put<Profile>("/api/profile", { downtime: { mode } }),
    onSuccess: (prof) => {
      qc.setQueryData(["profile"], prof);
      if (prof.downtime.mode === "run") api.post("/api/tick").catch(() => undefined);
      toast(MODES.find((m) => m.id === prof.downtime.mode)!.hint);
    },
  });
  const mode = p.data?.downtime.mode ?? "stop";
  return (
    <div className="mb-1.5 flex items-center gap-2 px-2.5">
      <span className="text-[12px] text-muted" title="Background growth of queued seeds">Auto-grow</span>
      <div className="ml-auto flex rounded-md bg-surface p-0.5">
        {MODES.map(({ id, icon: Icon, label, hint }) => (
          <button key={id} title={`${label}: ${hint}`} onClick={() => set.mutate(id)}
            className={cx("flex h-6 w-7 items-center justify-center rounded", mode === id ? "bg-base text-leaf-ink shadow-card" : "text-muted hover:text-text")}>
            <Icon size={11} fill={mode === id && id !== "scheduled" ? "currentColor" : "none"} />
          </button>
        ))}
      </div>
    </div>
  );
}

const SETTINGS_TABS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "models", label: "Models", icon: Cpu },
  { id: "feed", label: "Feed", icon: Rss },
  { id: "stats", label: "Statistics", icon: BarChart3 },
  { id: "docs", label: "Docs", icon: BookOpen },
];

function SettingsNav({ tab }: { tab: string }) {
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2">
      <NavItem icon={<ArrowLeft size={15} />} label="Go back" onClick={() => go(lastMain)} />
      <div className="h-4" />
      {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
        <NavItem key={id} icon={<Icon size={15} />} label={label} active={tab === id} onClick={() => go(`/settings/${id}`)} />
      ))}
    </nav>
  );
}
