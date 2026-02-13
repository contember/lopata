import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { WorkflowLimits } from "./bindings/workflow";

export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  durable_objects?: {
    bindings: { name: string; class_name: string }[];
  };
  workflows?: { name: string; binding: string; class_name: string; limits?: Partial<WorkflowLimits> }[];
  d1_databases?: { binding: string; database_name: string; database_id: string }[];
  queues?: {
    producers?: { binding: string; queue: string; delivery_delay?: number }[];
    consumers?: { queue: string; max_batch_size?: number; max_batch_timeout?: number; max_retries?: number; dead_letter_queue?: string }[];
  };
  services?: { binding: string; service: string; entrypoint?: string }[];
  triggers?: { crons?: string[] };
  vars?: Record<string, string>;
  assets?: {
    directory: string;
    binding?: string;
    html_handling?: "none" | "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash";
    not_found_handling?: "none" | "404-page" | "single-page-application";
    run_worker_first?: boolean | string[];
  };
  images?: {
    binding: string;
  };
  migrations?: { tag: string; new_classes?: string[]; new_sqlite_classes?: string[] }[];
  env?: Record<string, Partial<Omit<WranglerConfig, "env">>>;
}

/**
 * Load config from an explicit path (JSON/JSONC/TOML).
 */
export async function loadConfig(path: string, envName?: string): Promise<WranglerConfig> {
  const raw = await Bun.file(path).text();
  let config: WranglerConfig;
  if (path.endsWith(".toml")) {
    config = parseTOML(raw) as unknown as WranglerConfig;
  } else {
    // JSON or JSONC — strip single-line comments (// ...) outside strings
    config = JSON.parse(stripJsoncComments(raw));
  }
  return applyEnvOverrides(config, envName);
}

/**
 * Auto-detect config file in a directory. Tries wrangler.jsonc, wrangler.json, wrangler.toml.
 */
export async function autoLoadConfig(baseDir: string, envName?: string): Promise<WranglerConfig> {
  const candidates = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
  for (const name of candidates) {
    const fullPath = join(baseDir, name);
    if (existsSync(fullPath)) {
      return loadConfig(fullPath, envName);
    }
  }
  throw new Error(`No wrangler config found in ${baseDir} (tried: ${candidates.join(", ")})`);
}

/**
 * Merge environment-specific overrides into the base config.
 * Environment sections can override: vars, bindings, routes, triggers, etc.
 */
function applyEnvOverrides(config: WranglerConfig, envName?: string): WranglerConfig {
  if (!envName || !config.env) return config;
  const envConfig = config.env[envName];
  if (!envConfig) {
    throw new Error(`Environment "${envName}" not found in config. Available: ${Object.keys(config.env).join(", ")}`);
  }
  // Shallow merge: env-specific values override top-level ones
  const { env: _env, ...base } = config;
  const merged = { ...base };
  for (const [key, value] of Object.entries(envConfig)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

// ─── JSONC Comment Stripping ───────────────────────────────────────────────

function stripJsoncComments(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    // String literal — copy as-is
    if (input[i] === '"') {
      result += '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") {
          result += input[i]! + (input[i + 1] ?? "");
          i += 2;
        } else {
          result += input[i]!;
          i++;
        }
      }
      if (i < input.length) { result += '"'; i++; }
      continue;
    }
    // Single-line comment
    if (input[i] === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (input[i] === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += input[i]!;
    i++;
  }
  return result;
}

// ─── Lightweight TOML Parser ───────────────────────────────────────────────
// Supports: key/value pairs, strings (basic & literal), integers, floats,
// booleans, arrays, inline tables, tables ([section]), array of tables ([[section]]).
// Enough for wrangler.toml configs.

type TOMLValue = string | number | boolean | TOMLValue[] | { [key: string]: TOMLValue };

export function parseTOML(input: string): Record<string, TOMLValue> {
  const root: Record<string, TOMLValue> = {};
  let current = root;
  let currentPath: string[] = [];

  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = stripComment(raw).trim();
    if (!line) continue;

    // Array of tables: [[section.path]]
    const aotMatch = line.match(/^\[\[([^\]]+)\]\]\s*$/);
    if (aotMatch) {
      const path = parseKeyPath(aotMatch[1]!);
      currentPath = path;
      current = ensureArrayOfTables(root, path);
      continue;
    }

    // Table: [section.path]
    const tableMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (tableMatch) {
      const path = parseKeyPath(tableMatch[1]!);
      currentPath = path;
      current = ensureTable(root, path);
      continue;
    }

    // Key = Value
    const eqIndex = findUnquotedEquals(line);
    if (eqIndex === -1) {
      throw new Error(`TOML parse error at line ${i + 1}: expected key = value, got: ${raw}`);
    }
    const keyStr = line.slice(0, eqIndex).trim();
    const valStr = line.slice(eqIndex + 1).trim();
    const keyPath = parseKeyPath(keyStr);
    const value = parseValue(valStr, lines, i);

    // Set the value at the key path within current table
    setNestedValue(current, keyPath, value);
  }

  return root;
}

function stripComment(line: string): string {
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function findUnquotedEquals(line: string): number {
  let inStr = false;
  let strChar = "";
  let bracketDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      continue;
    }
    if (ch === "[" || ch === "{") { bracketDepth++; continue; }
    if (ch === "]" || ch === "}") { bracketDepth--; continue; }
    if (ch === "=" && bracketDepth === 0) return i;
  }
  return -1;
}

function parseKeyPath(keyStr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < keyStr.length; i++) {
    const ch = keyStr[i]!;
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }
    if (ch === ".") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) parts.push(last);
  return parts;
}

function parseValue(valStr: string, _lines: string[], _lineIdx: number): TOMLValue {
  if (!valStr) throw new Error("TOML parse error: empty value");

  // String (basic)
  if (valStr.startsWith('"')) {
    const end = valStr.indexOf('"', 1);
    if (end === -1) throw new Error(`TOML parse error: unterminated string: ${valStr}`);
    return unescapeString(valStr.slice(1, end));
  }

  // String (literal)
  if (valStr.startsWith("'")) {
    const end = valStr.indexOf("'", 1);
    if (end === -1) throw new Error(`TOML parse error: unterminated string: ${valStr}`);
    return valStr.slice(1, end);
  }

  // Boolean
  if (valStr === "true") return true;
  if (valStr === "false") return false;

  // Array
  if (valStr.startsWith("[")) {
    return parseInlineArray(valStr);
  }

  // Inline table
  if (valStr.startsWith("{")) {
    return parseInlineTable(valStr);
  }

  // Number (integer or float)
  const num = Number(valStr);
  if (!isNaN(num) && valStr !== "") return num;

  // Bare string fallback (shouldn't happen in valid TOML, but be lenient)
  return valStr;
}

function unescapeString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');
}

function parseInlineArray(input: string): TOMLValue[] {
  // Find matching ]
  const inner = extractBracketed(input, "[", "]");
  if (inner.trim() === "") return [];
  const items = splitTopLevel(inner, ",");
  return items.map(item => {
    const trimmed = item.trim();
    if (!trimmed) return trimmed;
    return parseValue(trimmed, [], 0);
  }).filter((v): v is TOMLValue => v !== "");
}

function parseInlineTable(input: string): Record<string, TOMLValue> {
  const inner = extractBracketed(input, "{", "}");
  if (inner.trim() === "") return {};
  const result: Record<string, TOMLValue> = {};
  const items = splitTopLevel(inner, ",");
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const eq = findUnquotedEquals(trimmed);
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    const val = trimmed.slice(eq + 1).trim();
    result[key] = parseValue(val, [], 0);
  }
  return result;
}

function extractBracketed(input: string, open: string, close: string): string {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return input.slice(start + 1, i);
    }
  }
  throw new Error(`TOML parse error: unmatched bracket in: ${input}`);
}

function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inStr) {
      current += ch;
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function ensureTable(root: Record<string, TOMLValue>, path: string[]): Record<string, TOMLValue> {
  let obj = root;
  for (const key of path) {
    if (!(key in obj)) {
      obj[key] = {};
    }
    const val = obj[key];
    if (Array.isArray(val)) {
      // Navigate to the last element of an array of tables
      obj = val[val.length - 1] as Record<string, TOMLValue>;
    } else {
      obj = val as Record<string, TOMLValue>;
    }
  }
  return obj;
}

function ensureArrayOfTables(root: Record<string, TOMLValue>, path: string[]): Record<string, TOMLValue> {
  let obj = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!(key in obj)) obj[key] = {};
    const val = obj[key];
    if (Array.isArray(val)) {
      obj = val[val.length - 1] as Record<string, TOMLValue>;
    } else {
      obj = val as Record<string, TOMLValue>;
    }
  }
  const lastKey = path[path.length - 1]!;
  if (!(lastKey in obj)) obj[lastKey] = [];
  const arr = obj[lastKey] as TOMLValue[];
  const newTable: Record<string, TOMLValue> = {};
  arr.push(newTable);
  return newTable;
}

function setNestedValue(obj: Record<string, TOMLValue>, path: string[], value: TOMLValue): void {
  let target = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!(key in target)) target[key] = {};
    target = target[key] as Record<string, TOMLValue>;
  }
  target[path[path.length - 1]!] = value;
}
