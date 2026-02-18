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
