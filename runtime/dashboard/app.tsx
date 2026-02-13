import { render } from "preact";
import { useRoute } from "./lib";
import { HomeView } from "./views/home";
import { KvView } from "./views/kv";
import { R2View } from "./views/r2";
import { QueueView } from "./views/queue";
import { DoView } from "./views/do";
import { WorkflowsView } from "./views/workflows";
import { D1View } from "./views/d1";
import { CacheView } from "./views/cache";

const NAV_ITEMS = [
  { path: "/", label: "Overview", icon: "◉" },
  { path: "/kv", label: "KV", icon: "⬡" },
  { path: "/r2", label: "R2", icon: "◧" },
  { path: "/queue", label: "Queues", icon: "☰" },
  { path: "/do", label: "Durable Objects", icon: "⬢" },
  { path: "/workflows", label: "Workflows", icon: "⇶" },
  { path: "/d1", label: "D1", icon: "⊞" },
  { path: "/cache", label: "Cache", icon: "◎" },
];

function App() {
  const route = useRoute();
  const activeSection = "/" + (route.split("/")[1] || "");

  function renderView() {
    if (route === "/" || route === "") return <HomeView />;
    if (route.startsWith("/kv")) return <KvView route={route} />;
    if (route.startsWith("/r2")) return <R2View route={route} />;
    if (route.startsWith("/queue")) return <QueueView route={route} />;
    if (route.startsWith("/do")) return <DoView route={route} />;
    if (route.startsWith("/workflows")) return <WorkflowsView route={route} />;
    if (route.startsWith("/d1")) return <D1View route={route} />;
    if (route.startsWith("/cache")) return <CacheView route={route} />;
    return <div class="p-8 text-gray-400">Page not found</div>;
  }

  return (
    <div class="flex h-full">
      <nav class="w-60 flex-shrink-0 bg-white rounded-card shadow-card flex flex-col m-3 mr-0">
        <div class="p-6 pb-4">
          <a href="#/" class="flex items-center gap-2.5 no-underline">
            <span class="w-10 h-10 rounded-full bg-accent-lime flex items-center justify-center text-lg">🔥</span>
            <div>
              <div class="text-lg font-bold text-ink">Bunflare</div>
              <div class="text-[11px] text-gray-400 font-medium">Dev Dashboard</div>
            </div>
          </a>
        </div>
        <div class="flex-1 overflow-y-auto scrollbar-thin px-3 py-2">
          {NAV_ITEMS.map(item => (
            <a
              key={item.path}
              href={`#${item.path}`}
              class={`flex items-center gap-3 px-4 py-2.5 mb-1 text-sm no-underline rounded-2xl transition-all ${
                activeSection === item.path
                  ? "bg-accent-lime text-ink font-semibold shadow-lime-glow"
                  : "text-gray-500 hover:bg-surface-raised hover:text-ink"
              }`}
            >
              <span class="w-5 text-center text-base">{item.icon}</span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      <main class="flex-1 overflow-y-auto scrollbar-thin">
        {renderView()}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
