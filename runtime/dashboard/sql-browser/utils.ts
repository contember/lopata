import type { TableSchema, ColumnInfo, ForeignKeyInfo } from "./types";

// ─── Schema parsing ──────────────────────────────────────────────────

export function parseCreateTable(sql: string): TableSchema {
  const columns: ColumnInfo[] = [];
  const primaryKeys: string[] = [];

  // Extract the part between the outer parentheses
  const bodyMatch = sql.match(/\((.+)\)\s*$/s);
  if (!bodyMatch) return { columns, primaryKeys };

  // Split on commas that are not inside nested parens
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of bodyMatch[1]!) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  const foreignKeys: Record<string, ForeignKeyInfo> = {};

  for (const part of parts) {
    // Table-level PRIMARY KEY(col1, col2)
    const pkMatch = part.match(/^PRIMARY\s+KEY\s*\((.+)\)/i);
    if (pkMatch) {
      for (const col of pkMatch[1]!.split(",")) {
        const name = col.trim().replace(/^["'`]|["'`]$/g, "");
        if (name && !primaryKeys.includes(name)) primaryKeys.push(name);
      }
      continue;
    }

    // Table-level FOREIGN KEY(col) REFERENCES table(col)
    const fkMatch = part.match(/^(?:CONSTRAINT\s+["'`]?\w+["'`]?\s+)?FOREIGN\s+KEY\s*\(["'`]?(\w+)["'`]?\)\s*REFERENCES\s+["'`]?(\w+)["'`]?\s*\(["'`]?(\w+)["'`]?\)/i);
    if (fkMatch) {
      foreignKeys[fkMatch[1]!] = { targetTable: fkMatch[2]!, targetColumn: fkMatch[3]! };
      continue;
    }

    // Skip other constraints (UNIQUE, CHECK)
    if (/^(UNIQUE|CHECK|CONSTRAINT)\s/i.test(part)) continue;

    // Column definition
    const colMatch = part.match(/^["'`]?(\w+)["'`]?\s+(.*)/s);
    if (!colMatch) continue;

    const name = colMatch[1]!;
    const rest = colMatch[2]!;
    const typePart = rest.match(/^(\w[\w\s()]*?)(?:\s+(?:NOT|NULL|DEFAULT|PRIMARY|UNIQUE|CHECK|REFERENCES|AUTOINCREMENT|AUTO_INCREMENT)|$)/i);
    const type = typePart ? typePart[1]!.trim() : rest.split(/\s/)[0] ?? "";
    const notNull = /\bNOT\s+NULL\b/i.test(rest);
    const autoIncrement = /\b(?:AUTOINCREMENT|AUTO_INCREMENT)\b/i.test(rest);
    const defaultMatch = rest.match(/\bDEFAULT\s+(\S+)/i);
    const defaultValue = defaultMatch ? defaultMatch[1]! : null;

    // Inline REFERENCES
    const refMatch = rest.match(/\bREFERENCES\s+["'`]?(\w+)["'`]?\s*\(["'`]?(\w+)["'`]?\)/i);
    const foreignKey: ForeignKeyInfo | null = refMatch
      ? { targetTable: refMatch[1]!, targetColumn: refMatch[2]! }
      : null;

    columns.push({ name, type, notNull, defaultValue, autoIncrement, foreignKey });

    if (/\bPRIMARY\s+KEY\b/i.test(rest)) {
      if (!primaryKeys.includes(name)) primaryKeys.push(name);
    }
  }

  // Apply table-level FK constraints to columns
  for (const col of columns) {
    if (!col.foreignKey && foreignKeys[col.name]) {
      col.foreignKey = foreignKeys[col.name]!;
    }
  }

  return { columns, primaryKeys };
}

// ─── SQL helpers ─────────────────────────────────────────────────────

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function parseFilterExpr(col: string, expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "null") return `${quoteId(col)} IS NULL`;
  if (lower === "!null" || lower === "not null") return `${quoteId(col)} IS NOT NULL`;

  // Operators: >=, <=, !=, >, <, =
  const opMatch = trimmed.match(/^(>=|<=|!=|>|<|=)\s*(.+)$/);
  if (opMatch) {
    const [, op, val] = opMatch;
    return `${quoteId(col)} ${op} ${sqlLiteral(val!)}`;
  }

  // LIKE pattern (contains %)
  if (trimmed.includes("%")) {
    return `${quoteId(col)} LIKE ${sqlLiteral(trimmed)}`;
  }

  // Negation: !value
  if (trimmed.startsWith("!")) {
    return `${quoteId(col)} != ${sqlLiteral(trimmed.slice(1))}`;
  }

  // Default: contains
  return `${quoteId(col)} LIKE ${sqlLiteral("%" + trimmed + "%")}`;
}

export function buildWhereClause(filters: Record<string, string>): string {
  const conditions: string[] = [];
  for (const [col, expr] of Object.entries(filters)) {
    const cond = parseFilterExpr(col, expr);
    if (cond) conditions.push(cond);
  }
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
}

// ─── Export helpers ──────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportCSV(columns: string[], rows: Record<string, unknown>[], tableName: string) {
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = columns.map(escape).join(",");
  const body = rows.map(row => columns.map(col => escape(row[col])).join(",")).join("\n");
  downloadBlob(header + "\n" + body, `${tableName}.csv`, "text/csv");
}

export function exportJSON(rows: Record<string, unknown>[], tableName: string) {
  downloadBlob(JSON.stringify(rows, null, 2), `${tableName}.json`, "application/json");
}
