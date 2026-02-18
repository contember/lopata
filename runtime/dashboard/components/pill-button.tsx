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
