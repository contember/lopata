import type { ComponentChildren } from "preact";

export function Modal({ title, onClose, maxWidth, children }: {
  title: string | ComponentChildren;
  onClose: () => void;
  maxWidth?: string;
  children: ComponentChildren;
}) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class={`bg-panel rounded-xl shadow-xl border border-border w-full ${maxWidth ?? "max-w-lg"} mx-4 max-h-[80vh] flex flex-col`}>
        <div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 class="text-sm font-bold text-ink">{title}</h3>
          <button onClick={onClose} class="text-text-muted hover:text-text-data text-lg leading-none transition-colors">&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}
