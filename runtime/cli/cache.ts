import type { CliContext } from "./context";
import { parseFlag } from "./context";

export async function run(ctx: CliContext, args: string[]) {
	const action = args[0];

	switch (action) {
		case "list": {
			const db = ctx.db();
			const rows = db.query<{ cache_name: string; cnt: number }, []>(
				"SELECT cache_name, COUNT(*) as cnt FROM cache_entries GROUP BY cache_name ORDER BY cache_name",
			).all();
			if (rows.length === 0) {
				console.log("(no cache entries)");
				return;
			}
			for (const row of rows) {
				console.log(`${row.cache_name}  ${row.cnt} entries`);
			}
			break;
		}
		case "purge": {
			const cacheName = parseFlag(ctx.args, "--name");
			const db = ctx.db();
			let result;
			if (cacheName) {
				result = db.run("DELETE FROM cache_entries WHERE cache_name = ?", [cacheName]);
				console.log(`Purged ${result.changes} entries from cache "${cacheName}"`);
			} else {
				result = db.run("DELETE FROM cache_entries");
				console.log(`Purged ${result.changes} cache entries (all caches)`);
			}
			break;
		}
		default:
			console.error("Usage: bunflare cache <list|purge> [options]");
			process.exit(1);
	}
}
