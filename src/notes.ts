import { DurableObject } from "cloudflare:workers";

export class SqlNotes extends DurableObject<Env> {
  private _initialized = false;

  private _ensureTable() {
    if (this._initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this._initialized = true;
  }

  async list(): Promise<Record<string, unknown>[]> {
    this._ensureTable();
    return this.ctx.storage.sql
      .exec("SELECT * FROM notes ORDER BY updated_at DESC")
      .toArray();
  }

  async get(id: number): Promise<Record<string, unknown>> {
    this._ensureTable();
    return this.ctx.storage.sql
      .exec("SELECT * FROM notes WHERE id = ?", id)
      .one();
  }

  async create(title: string, body: string = ""): Promise<Record<string, unknown>> {
    this._ensureTable();
    this.ctx.storage.sql.exec(
      "INSERT INTO notes (title, body) VALUES (?, ?)",
      title,
      body,
    );
    const lastId = this.ctx.storage.sql
      .exec("SELECT last_insert_rowid() as id")
      .one() as { id: number };
    return this.get(lastId.id);
  }

  async update(id: number, title: string, body: string): Promise<Record<string, unknown>> {
    this._ensureTable();
    this.ctx.storage.sql.exec(
      "UPDATE notes SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?",
      title,
      body,
      id,
    );
    return this.get(id);
  }

  async remove(id: number): Promise<void> {
    this._ensureTable();
    this.ctx.storage.sql.exec("DELETE FROM notes WHERE id = ?", id);
  }
}
