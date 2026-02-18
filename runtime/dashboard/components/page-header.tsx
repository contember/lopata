export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-ink">{title}</h1>
      {subtitle && <div class="text-sm text-text-muted mt-1 font-medium">{subtitle}</div>}
    </div>
  );
}
