export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover transition-all" title="Refresh">
      Refresh
    </button>
  );
}
