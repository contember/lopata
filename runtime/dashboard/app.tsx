import { render } from "preact";
import { useRoute, navigate } from "./lib";
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
    return <div class="p-8 text-gray-500">Page not found</div>;
  }

  return (
    <div class="flex h-full">
      {/* Sidebar */}
      <nav class="w-56 flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div class="p-4 border-b border-gray-200 dark:border-gray-800">
          <a href="#/" class="flex items-center gap-2 text-lg font-semibold text-orange-600 dark:text-orange-400 no-underline">
            <span class="text-xl">🔥</span> Bunflare
          </a>
          <div class="text-xs text-gray-400 mt-1">Dev Dashboard</div>
        </div>
        <div class="flex-1 overflow-y-auto scrollbar-thin py-2">
          {NAV_ITEMS.map(item => (
            <a
              key={item.path}
              href={`#${item.path}`}
              class={`flex items-center gap-3 px-4 py-2 text-sm no-underline transition-colors ${
                activeSection === item.path
                  ? "bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 font-medium"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
              }`}
            >
              <span class="w-5 text-center">{item.icon}</span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main class="flex-1 overflow-y-auto scrollbar-thin">
        {renderView()}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
