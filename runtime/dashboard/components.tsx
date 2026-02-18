import { useState } from "preact/hooks";
import type { D1Table, QueryResult } from "./rpc/types";

// Shared UI components for the dashboard

export function EmptyState({ message }: { message: string }) {
  return (
    <div class="text-center py-16 text-gray-400">
      <div class="text-5xl mb-3 opacity-50">&#8709;</div>
      <div class="text-sm font-medium">{message}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-ink">{title}</h1>
      {subtitle && <div class="text-sm text-gray-400 mt-1 font-medium">{subtitle}</div>}
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <div class="flex items-center gap-2 text-sm text-gray-400 mb-8">
      {items.map((item, i) => (
        <span key={i} class="flex items-center gap-2">
          {i > 0 && <span class="text-gray-300">/</span>}
          {item.href ? (
            <a href={item.href} class="text-gray-500 hover:text-ink no-underline font-medium transition-colors">{item.label}</a>
          ) : (
            <span class="text-ink font-semibold">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

export function Table({ headers, rows }: { headers: string[]; rows: unknown[][] }) {
  return (
    <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-100">
            {headers.map(h => (
              <th key={h} class="text-left px-4 py-3 font-medium text-xs text-gray-400 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} class="group border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
              {row.map((cell, j) => (
                <td key={j} class="px-4 py-3">
                  {cell as any}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DetailField({ label, value, children }: { label: string; value?: string; children?: any }) {
  return (
    <div class="bg-white rounded-lg border border-gray-200 p-5">
      <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</div>
      {value ? <div class="font-mono text-sm font-medium">{value}</div> : children}
    </div>
  );
}

export function CodeBlock({ children, class: className }: { children: any; class?: string }) {
  return (
    <pre class={`bg-gray-50 rounded-lg p-4 text-xs overflow-x-auto font-mono ${className ?? ""}`}>{children}</pre>
  );
}

export function FilterInput({ value, onInput, placeholder, class: className }: { value: string; onInput: (v: string) => void; placeholder?: string; class?: string }) {
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onInput={e => onInput((e.target as HTMLInputElement).value)}
      class={`bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all ${className ?? "w-72"}`}
    />
  );
}

export function PillButton({ onClick, active, children }: { onClick: () => void; active?: boolean; children: any }) {
  return (
    <button
      onClick={onClick}
      class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
        active
          ? "bg-ink text-white"
          : "bg-white border border-gray-200 text-gray-500 hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
  );
}

export function LoadMoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="mt-4 rounded-md px-3 py-1.5 text-sm font-medium bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all">
      Load more
    </button>
  );
}

export function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="text-red-400 hover:text-red-600 text-xs font-medium rounded-md px-2 py-1 hover:bg-red-50 transition-all">Delete</button>
  );
}

export function TableLink({ href, children, mono }: { href: string; children: any; mono?: boolean }) {
  return (
    <a href={href} class={`text-ink font-medium hover:text-accent-olive transition-colors no-underline ${mono ? "font-mono text-xs" : ""}`}>{children}</a>
  );
}

export function StatusBadge({ status, colorMap }: { status: string; colorMap: Record<string, string> }) {
  return (
    <span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-semibold ${colorMap[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

export function ServiceInfo({ description, links, stats, configGroups }: {
  description: string;
  links: { label: string; href: string }[];
  stats?: { label: string; value: string | number }[];
  configGroups?: { title: string; items: { name: string; value: string }[] }[] | null;
}) {
  return (
    <div class="w-80 flex-shrink-0 space-y-5">
      {stats && stats.length > 0 && (
        <div class="grid grid-cols-2 gap-2">
          {stats.map(stat => (
            <div key={stat.label} class="bg-white border border-gray-200 rounded-lg px-3.5 py-3">
              <div class="text-xs text-gray-400 font-medium">{stat.label}</div>
              <div class="text-xl font-semibold text-ink mt-0.5 tabular-nums">{stat.value}</div>
            </div>
          ))}
        </div>
      )}
      {configGroups && configGroups.length > 0 && configGroups.map(group => (
        <div key={group.title}>
          <div class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">{group.title}</div>
          <div class="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
            {group.items.map(item => (
              <div key={item.name} class="px-3.5 py-2.5">
                <div class="text-xs font-medium text-ink">{item.name}</div>
                <div class="text-xs text-gray-400 font-mono mt-0.5 truncate" title={item.value}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div>
        <p class="text-xs text-gray-400 leading-relaxed mb-2.5">{description}</p>
        <div class="space-y-1.5">
          {links.map(link => (
            <a key={link.href} href={link.href} target="_blank" rel="noopener"
               class="flex items-center gap-1.5 text-xs text-gray-400 hover:text-ink no-underline transition-colors">
              <span>&rarr;</span> {link.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SqlBrowser({ tables, onRunQuery, query }: {
  tables?: D1Table[] | null;
  onRunQuery: (sql: string) => void;
  query: { data: QueryResult | null; error: Error | null; isLoading: boolean };
}) {
  const [sql, setSql] = useState("");

  return (
    <>
      {/* Tables */}
      <div class="mb-8">
        <h3 class="text-lg font-bold mb-4">Tables</h3>
        {!tables?.length ? (
          <EmptyState message="No tables found" />
        ) : (
          <Table
            headers={["Table", "Rows", "Schema"]}
            rows={tables.map(t => [
              <button
                onClick={() => setSql(`SELECT * FROM "${t.name}" LIMIT 100`)}
                class="text-ink font-medium hover:text-accent-olive transition-colors font-mono text-xs"
              >
                {t.name}
              </button>,
              <span class="tabular-nums">{t.rows}</span>,
              <pre class="text-xs text-gray-400 max-w-lg truncate font-mono">{t.sql}</pre>,
            ])}
          />
        )}
      </div>

      {/* SQL Console */}
      <div class="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 class="text-lg font-bold mb-4">SQL Console</h3>
        <textarea
          value={sql}
          onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onRunQuery(sql); }}
          placeholder="SELECT * FROM ..."
          class="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 font-mono text-sm outline-none min-h-[100px] resize-y focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all mb-4"
        />
        <div class="flex items-center gap-3">
          <button
            onClick={() => onRunQuery(sql)}
            disabled={query.isLoading || !sql.trim()}
            class="rounded-md px-4 py-2 text-sm font-medium bg-ink text-white hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {query.isLoading ? "Running..." : "Run Query"}
          </button>
          <span class="text-xs text-gray-400">Ctrl+Enter to run</span>
        </div>
      </div>

      {/* Results */}
      {query.error ? (
        <div class="bg-red-50 text-red-600 p-4 rounded-lg text-sm font-medium">
          {query.error.message}
        </div>
      ) : query.data ? (
        <div>
          {query.data.message ? (
            <div class="bg-emerald-50 text-emerald-700 p-4 rounded-lg text-sm font-medium">
              {query.data.message}
            </div>
          ) : query.data.columns.length > 0 ? (
            <div>
              <div class="text-sm text-gray-400 mb-3 font-medium">{query.data.count} row(s)</div>
              <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-100">
                      {query.data.columns.map(col => (
                        <th key={col} class="text-left px-4 py-2.5 font-medium text-xs text-gray-400 uppercase tracking-wider font-mono">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((row, i) => (
                      <tr key={i} class="group border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                        {query.data!.columns.map((col) => (
                          <td key={col} class="px-4 py-2.5 font-mono text-xs">
                            {row[col] === null ? <span class="text-gray-300 italic">NULL</span> : String(row[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
