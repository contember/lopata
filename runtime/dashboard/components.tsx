// Shared UI components for the dashboard

export function EmptyState({ message }: { message: string }) {
  return (
    <div class="text-center py-16 text-gray-400">
      <div class="text-5xl mb-3 opacity-50">∅</div>
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
    <div class="bg-white rounded-card shadow-card p-5 overflow-x-auto">
      <table class="w-full text-sm" style="border-collapse: separate; border-spacing: 0 6px;">
        <thead>
          <tr>
            {headers.map(h => (
              <th key={h} class="text-left px-5 pb-2 font-medium text-xs text-gray-400 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} class="group">
              {row.map((cell, j) => (
                <td
                  key={j}
                  class={`px-5 py-3.5 bg-surface-raised group-hover:bg-surface-hover transition-colors ${
                    j === 0 ? "rounded-l-2xl" : ""
                  } ${j === row.length - 1 ? "rounded-r-2xl" : ""}`}
                >
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
    <div class="bg-white rounded-card shadow-card p-5">
      <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</div>
      {value ? <div class="font-mono text-sm font-medium">{value}</div> : children}
    </div>
  );
}

export function CodeBlock({ children, class: className }: { children: any; class?: string }) {
  return (
    <pre class={`bg-surface-raised rounded-2xl p-5 text-xs overflow-x-auto font-mono ${className ?? ""}`}>{children}</pre>
  );
}

export function FilterInput({ value, onInput, placeholder, class: className }: { value: string; onInput: (v: string) => void; placeholder?: string; class?: string }) {
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onInput={e => onInput((e.target as HTMLInputElement).value)}
      class={`bg-surface-raised border-none rounded-2xl px-5 py-3 text-sm outline-none focus:bg-white focus:shadow-focus transition-all ${className ?? "w-72"}`}
    />
  );
}

export function PillButton({ onClick, active, children }: { onClick: () => void; active?: boolean; children: any }) {
  return (
    <button
      onClick={onClick}
      class={`rounded-full px-5 py-2 text-sm font-medium transition-all ${
        active
          ? "bg-accent-lime text-ink shadow-lime-glow"
          : "bg-surface-raised text-gray-500 hover:bg-surface-dim"
      }`}
    >
      {children}
    </button>
  );
}

export function LoadMoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="mt-4 rounded-full px-5 py-2.5 text-sm font-medium bg-surface-raised hover:bg-surface-dim transition-all">
      Load more
    </button>
  );
}

export function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="text-red-400 hover:text-red-600 text-xs font-medium rounded-full px-3 py-1 hover:bg-red-50 transition-all">Delete</button>
  );
}

export function TableLink({ href, children, mono }: { href: string; children: any; mono?: boolean }) {
  return (
    <a href={href} class={`text-ink font-semibold hover:text-accent-olive transition-colors no-underline ${mono ? "font-mono text-xs font-medium" : ""}`}>{children}</a>
  );
}

export function StatusBadge({ status, colorMap }: { status: string; colorMap: Record<string, string> }) {
  return (
    <span class={`inline-flex px-3.5 py-1 rounded-full text-xs font-semibold ${colorMap[status] ?? "bg-gray-200 text-gray-600"}`}>
      {status}
    </span>
  );
}
