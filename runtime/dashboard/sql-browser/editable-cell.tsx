import { useState, useEffect, useRef } from "preact/hooks";
import type { ForeignKeyInfo } from "./types";

export function EditableCell({ value, onSave, foreignKey, onNavigateFK, onInspect }: {
  value: unknown;
  onSave: (v: unknown) => void;
  foreignKey?: ForeignKeyInfo | null;
  onNavigateFK?: (fk: ForeignKeyInfo) => void;
  onInspect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isNull, setIsNull] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLong = value !== null && value !== undefined && String(value).length > 80;

  const startEdit = () => {
    setIsNull(value === null);
    setEditValue(value === null ? "" : String(value));
    setEditing(true);
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = () => {
    const newValue = isNull ? null : editValue;
    setEditing(false);
    // Only save if value actually changed
    if (newValue !== (value === null ? null : String(value))) {
      onSave(newValue);
    }
  };

  const cancel = () => {
    setEditing(false);
  };

  if (editing) {
    return (
      <div class="flex items-center gap-1 py-1">
        <input
          ref={inputRef}
          type="text"
          value={isNull ? "" : editValue}
          disabled={isNull}
          onInput={e => setEditValue((e.target as HTMLInputElement).value)}
          onKeyDown={e => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") cancel();
          }}
          class={`w-full bg-panel-secondary border border-border rounded px-2 py-1 font-mono text-xs outline-none focus:border-ink focus:ring-1 focus:ring-border ${isNull ? "opacity-40" : ""}`}
        />
        <button
          onClick={() => { setIsNull(!isNull); if (!isNull) setEditValue(""); }}
          title={isNull ? "Set to value" : "Set to NULL"}
          class={`flex-shrink-0 rounded px-1.5 py-1 text-xs font-bold transition-colors ${
            isNull ? "bg-amber-100 text-amber-700" : "bg-panel-hover text-text-muted hover:bg-panel-active"
          }`}
        >
          N
        </button>
      </div>
    );
  }

  return (
    <div class="flex items-center gap-1 font-mono text-xs py-2 min-h-[2rem]">
      <div
        onClick={startEdit}
        class="cursor-pointer flex-1 min-w-0 flex items-center"
      >
        {value === null ? (
          <span class="text-text-dim italic">NULL</span>
        ) : foreignKey ? (
          <span class="truncate max-w-xs text-blue-600" title={String(value)}>{String(value)}</span>
        ) : (
          <span class="truncate max-w-xs" title={String(value)}>{String(value)}</span>
        )}
      </div>
      {foreignKey && value != null && onNavigateFK && (
        <button
          onClick={e => { e.stopPropagation(); onNavigateFK(foreignKey); }}
          class="flex-shrink-0 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 hover:text-blue-800 px-1.5 py-0.5 rounded transition-colors"
          title={`Go to ${foreignKey.targetTable}.${foreignKey.targetColumn}`}
        >
          &rarr; {foreignKey.targetTable}
        </button>
      )}
      {isLong && onInspect && (
        <button
          onClick={e => { e.stopPropagation(); onInspect(); }}
          class="flex-shrink-0 text-[10px] text-text-muted hover:text-text-data px-1 py-0.5 rounded hover:bg-panel-hover transition-colors"
          title="Inspect value"
        >
          &#x2922;
        </button>
      )}
    </div>
  );
}
