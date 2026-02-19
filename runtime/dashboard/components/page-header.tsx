export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: preact.ComponentChildren }) {
  return (
    <div class="mb-8 flex items-start justify-between">
      <div>
        <h1 class="text-3xl font-bold text-ink">{title}</h1>
        {subtitle && <div class="text-sm text-text-muted mt-1 font-medium">{subtitle}</div>}
      </div>
      {actions && <div class="flex gap-2 items-center">{actions}</div>}
    </div>
  );
}
