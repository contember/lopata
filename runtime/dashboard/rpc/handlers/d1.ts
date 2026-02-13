import type { HandlerContext, D1Database as D1DatabaseInfo, D1Table, QueryResult } from "../types";
import { getAllConfigs } from "../types";
import { getDataDir } from "../../../db";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export const handlers = {
  "d1.listDatabases"(_input: {}, ctx: HandlerContext): D1DatabaseInfo[] {
    const d1Dir = join(getDataDir(), "d1");
    const databases: D1DatabaseInfo[] = [];
    const seen = new Set<string>();

    if (existsSync(d1Dir)) {
      const files = readdirSync(d1Dir).filter(f => f.endsWith(".sqlite"));
      for (const f of files) {
        const name = f.replace(".sqlite", "");
        seen.add(name);
        const d1db = new Database(join(d1Dir, f));
        try {
          const tables = d1db.query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          ).all();
          databases.push({ name, tables: tables.length });
        } finally {
          d1db.close();
        }
      }
    }

    for (const config of getAllConfigs(ctx)) {
      for (const d of config.d1_databases ?? []) {
        if (!seen.has(d.database_name)) {
          databases.push({ name: d.database_name, tables: 0 });
          seen.add(d.database_name);
        }
      }
    }

    databases.sort((a, b) => a.name.localeCompare(b.name));
    return databases;
  },

  "d1.listTables"({ dbName }: { dbName: string }): D1Table[] {
    const dbPath = join(getDataDir(), "d1", `${dbName}.sqlite`);
    if (!existsSync(dbPath)) throw new Error("Database not found");

    const d1db = new Database(dbPath);
    try {
      const tables = d1db.query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();

      return tables.map(t => {
        const row = d1db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
        return { name: t.name, sql: t.sql, rows: row?.count ?? 0 };
      });
    } finally {
      d1db.close();
    }
  },

  "d1.query"({ dbName, sql }: { dbName: string; sql: string }): QueryResult {
    if (!sql) throw new Error("Missing sql field");

    const dbPath = join(getDataDir(), "d1", `${dbName}.sqlite`);
    if (!existsSync(dbPath)) throw new Error("Database not found");

    const d1db = new Database(dbPath);
    try {
      const stmt = d1db.prepare(sql);
      if (stmt.columnNames.length > 0) {
        const rows = stmt.all() as Record<string, unknown>[];
        return { columns: stmt.columnNames, rows, count: rows.length };
      } else {
        stmt.run();
        const changes = d1db.query<{ c: number }, []>("SELECT changes() as c").get()?.c ?? 0;
        return { columns: [], rows: [], count: changes, message: `${changes} row(s) affected` };
      }
    } finally {
      d1db.close();
    }
  },
};
