// Shared UI components for the dashboard

export { SqlBrowser } from "./sql-browser/index";

export function EmptyState({ message }: { message: string }) {
  return (
    <div class="text-center py-16 text-text-muted">
      <div class="text-5xl mb-3 opacity-50">&#8709;</div>
      <div class="text-sm font-medium">{message}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-ink">{title}</h1>
      {subtitle && <div class="text-sm text-text-muted mt-1 font-medium">{subtitle}</div>}
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <div class="flex items-center gap-2 text-sm text-text-muted mb-8">
      {items.map((item, i) => (
        <span key={i} class="flex items-center gap-2">
          {i > 0 && <span class="text-text-dim">/</span>}
          {item.href ? (
            <a href={item.href} class="text-text-secondary hover:text-ink no-underline font-medium transition-colors">{item.label}</a>
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
    <div class="bg-panel rounded-lg border border-border overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border-subtle">
            {headers.map(h => (
              <th key={h} class="text-left px-4 py-3 font-medium text-xs text-text-muted uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} class="group border-b border-border-row last:border-0 hover:bg-panel-hover/50 transition-colors">
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
    <div class="bg-panel rounded-lg border border-border p-5">
      <div class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{label}</div>
      {value ? <div class="font-mono text-sm font-medium">{value}</div> : children}
    </div>
  );
}

export function CodeBlock({ children, class: className }: { children: any; class?: string }) {
  return (
    <pre class={`bg-panel-secondary rounded-lg p-4 text-xs overflow-x-auto font-mono ${className ?? ""}`}>{children}</pre>
  );
}

export function FilterInput({ value, onInput, placeholder, class: className }: { value: string; onInput: (v: string) => void; placeholder?: string; class?: string }) {
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onInput={e => onInput((e.target as HTMLInputElement).value)}
      class={`bg-panel border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-border focus:ring-1 focus:ring-border transition-all ${className ?? "w-72"}`}
    />
  );
}

export function PillButton({ onClick, active, children }: { onClick: () => void; active?: boolean; children: any }) {
  return (
    <button
      onClick={onClick}
      class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
        active
          ? "bg-ink text-surface"
          : "bg-panel border border-border text-text-secondary hover:bg-panel-hover"
      }`}
    >
      {children}
    </button>
  );
}

export function LoadMoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="mt-4 rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover transition-all">
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
    <span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-semibold ${colorMap[status] ?? "bg-panel-hover text-text-data"}`}>
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
            <div key={stat.label} class="bg-panel border border-border rounded-lg px-3.5 py-3">
              <div class="text-xs text-text-muted font-medium">{stat.label}</div>
              <div class="text-xl font-semibold text-ink mt-0.5 tabular-nums">{stat.value}</div>
            </div>
          ))}
        </div>
      )}
      {configGroups && configGroups.length > 0 && configGroups.map(group => (
        <div key={group.title}>
          <div class="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">{group.title}</div>
          <div class="bg-panel border border-border rounded-lg divide-y divide-border-subtle">
            {group.items.map(item => (
              <div key={item.name} class="px-3.5 py-2.5">
                <div class="text-xs font-medium text-ink">{item.name}</div>
                <div class="text-xs text-text-muted font-mono mt-0.5 truncate" title={item.value}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div>
        <p class="text-xs text-text-muted leading-relaxed mb-2.5">{description}</p>
        <div class="space-y-1.5">
          {links.map(link => (
            <a key={link.href} href={link.href} target="_blank" rel="noopener"
               class="flex items-center gap-1.5 text-xs text-text-muted hover:text-ink no-underline transition-colors">
              <span>&rarr;</span> {link.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

