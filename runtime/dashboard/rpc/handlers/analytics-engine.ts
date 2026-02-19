import type { HandlerContext, OkResponse, AnalyticsEngineDataPoint as AEDataPoint } from "../types";
import { getDatabase } from "../../../db";
import type { SQLQueryBindings } from "bun:sqlite";

export const handlers = {
	"analyticsEngine.list"({ dataset, limit = 50 }: { dataset?: string; limit?: number }): AEDataPoint[] {
		const db = getDatabase();
		let query = "SELECT id, dataset, timestamp, index1, blob1, blob2, blob3, blob4, blob5, double1, double2, double3, double4, double5, _sample_interval FROM analytics_engine";
		const params: SQLQueryBindings[] = [];

		if (dataset) {
			query += " WHERE dataset = ?";
			params.push(dataset);
		}
		query += " ORDER BY timestamp DESC LIMIT ?";
		params.push(limit);

		return db.prepare(query).all(...params) as AEDataPoint[];
	},

	"analyticsEngine.get"({ id }: { id: string }): AEDataPoint | null {
		const db = getDatabase();
		return db.query<AEDataPoint, [string]>(
			`SELECT * FROM analytics_engine WHERE id = ?`,
		).get(id);
	},

	"analyticsEngine.delete"({ id }: { id: string }): OkResponse {
		const db = getDatabase();
		db.prepare("DELETE FROM analytics_engine WHERE id = ?").run(id);
		return { ok: true };
	},

	"analyticsEngine.datasets"(_input: {}): string[] {
		const db = getDatabase();
		return db.query<{ dataset: string }, []>(
			"SELECT DISTINCT dataset FROM analytics_engine ORDER BY dataset",
		).all().map(r => r.dataset);
	},

	"analyticsEngine.stats"(_input: {}): { total: number; byDataset: Record<string, number> } {
		const db = getDatabase();
		const total = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM analytics_engine").get()?.count ?? 0;

		const rows = db.query<{ dataset: string; count: number }, []>(
			"SELECT dataset, COUNT(*) as count FROM analytics_engine GROUP BY dataset ORDER BY count DESC",
		).all();
		const byDataset: Record<string, number> = {};
		for (const r of rows) byDataset[r.dataset] = r.count;

		return { total, byDataset };
	},
};
