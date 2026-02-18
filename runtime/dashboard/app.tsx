import { render } from "preact";
import { useRoute } from "./lib";
import { HomeView } from "./views/home";
import { KvView } from "./views/kv";
import { R2View } from "./views/r2";
import { QueueView } from "./views/queue";
import { DoView } from "./views/do";
import { WorkflowsView } from "./views/workflows";
import { ContainersView } from "./views/containers";
import { D1View } from "./views/d1";
import { CacheView } from "./views/cache";
import { WorkersView } from "./views/workers";
import { TracesView } from "./views/traces";
import { ErrorsView } from "./views/errors";
import { ScheduledView } from "./views/scheduled";

const NAV_ITEMS = [
  { path: "/", label: "Overview", icon: "◉" },
  { path: "/errors", label: "Errors", icon: "⚠" },
  { path: "/traces", label: "Traces", icon: "⟡" },
  { path: "/workers", label: "Workers", icon: "⊡" },
  { path: "/kv", label: "KV", icon: "⬡" },
  { path: "/r2", label: "R2", icon: "◧" },
  { path: "/queue", label: "Queues", icon: "☰" },
  { path: "/do", label: "Durable Objects", icon: "⬢" },
  { path: "/workflows", label: "Workflows", icon: "⇶" },
  { path: "/containers", label: "Containers", icon: "▣" },
  { path: "/d1", label: "D1", icon: "⊞" },
  { path: "/cache", label: "Cache", icon: "◎" },
  { path: "/scheduled", label: "Scheduled", icon: "⏱" },
];

function App() {
  const route = useRoute();
  const activeSection = "/" + (route.split("/")[1] || "");

  function renderView() {
    if (route === "/" || route === "") return <HomeView />;
    if (route.startsWith("/errors")) return <ErrorsView route={route} />;
    if (route.startsWith("/traces")) return <TracesView />;
    if (route.startsWith("/workers")) return <WorkersView />;
    if (route.startsWith("/kv")) return <KvView route={route} />;
    if (route.startsWith("/r2")) return <R2View route={route} />;
    if (route.startsWith("/queue")) return <QueueView route={route} />;
    if (route.startsWith("/do")) return <DoView route={route} />;
    if (route.startsWith("/workflows")) return <WorkflowsView route={route} />;
    if (route.startsWith("/containers")) return <ContainersView route={route} />;
    if (route.startsWith("/d1")) return <D1View route={route} />;
    if (route.startsWith("/cache")) return <CacheView route={route} />;
    if (route.startsWith("/scheduled")) return <ScheduledView route={route} />;
    return <div class="p-8 text-text-muted">Page not found</div>;
  }

  return (
    <div class="flex h-full">
      <nav class="w-56 flex-shrink-0 border-r border-border bg-panel flex flex-col">
        <div class="p-5 pb-4">
          <a href="#/" class="flex items-center gap-2.5 no-underline">
            <span class="w-8 h-8 rounded-lg bg-ink flex items-center justify-center text-sm text-white">B</span>
            <div>
              <div class="text-sm font-semibold text-ink">Bunflare</div>
              <div class="text-[11px] text-text-muted">Dev Dashboard</div>
            </div>
          </a>
        </div>
        <div class="flex-1 overflow-y-auto scrollbar-thin px-3 py-1">
          {NAV_ITEMS.map(item => (
            <a
              key={item.path}
              href={`#${item.path}`}
              class={`flex items-center gap-2.5 px-3 py-2 mb-0.5 text-sm no-underline rounded-md transition-colors ${
                activeSection === item.path
                  ? "bg-panel-hover text-ink font-medium"
                  : "text-text-secondary hover:bg-panel-hover hover:text-ink"
              }`}
            >
              <span class="w-4 text-center text-sm opacity-60">{item.icon}</span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      <main class="flex-1 overflow-y-auto scrollbar-thin bg-surface">
        {renderView()}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
