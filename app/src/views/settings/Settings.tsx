import Docs from "./Docs";
import FeedSettings from "./FeedSettings";
import Models from "./Models";
import ProfileSettings from "./Profile";
import Stats from "./Stats";

export default function SettingsView({ tab }: { tab: string }) {
  if (tab === "docs") return <Docs />;
  return (
    <div className="h-full overflow-auto">
      <div className={tab === "docs" ? "" : "mx-auto max-w-[960px] px-8 py-7"}>
        {tab === "profile" && <ProfileSettings />}
        {tab === "models" && <Models />}
        {tab === "feed" && <FeedSettings />}
        {tab === "stats" && <Stats />}
        {tab === "docs" && <Docs />}
      </div>
    </div>
  );
}

export function SettingsTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="m-0 text-[21.5px] font-semibold tracking-[-0.01em]">{title}</h1>
      {sub && <p className="m-0 mt-1 text-[14px] text-subtext">{sub}</p>}
    </div>
  );
}

export function Card({ title, icon, children, right }: { title?: string; icon?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-border-soft">
      {title && (
        <div className="flex items-center gap-2 border-b border-border-soft px-5 py-3">
          {icon && <span className="text-subtext">{icon}</span>}
          <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
          <div className="ml-auto">{right}</div>
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
