import type { CliContext } from "./context";
import { parseFlag, resolveBinding } from "./context";
import { FileR2Bucket } from "../bindings/r2";

export async function run(ctx: CliContext, args: string[]) {
	const sub = args[0];
	if (sub !== "object") {
		console.error(`Usage: bunflare r2 object <list|get|put|delete> [options]`);
		process.exit(1);
	}

	const action = args[1];
	const config = await ctx.config();
	const bucketFlag = parseFlag(ctx.args, "--bucket");
	const binding = resolveBinding(config.r2_buckets, bucketFlag, "R2 bucket", "bucket_name");
	const bucket = new FileR2Bucket(ctx.db(), binding.bucket_name, ctx.dataDir());

	switch (action) {
		case "list": {
			const prefix = parseFlag(ctx.args, "--prefix") ?? "";
			let cursor = "";
			let total = 0;
			do {
				const result = await bucket.list({ prefix, cursor: cursor || undefined });
				for (const obj of result.objects) {
					const size = formatSize(obj.size);
					const date = obj.uploaded.toISOString().slice(0, 19).replace("T", " ");
					console.log(`${date}  ${size.padStart(10)}  ${obj.key}`);
				}
				total += result.objects.length;
				cursor = result.cursor;
			} while (cursor);
			if (total === 0) console.log("(no objects)");
			break;
		}
		case "get": {
			const key = args[2];
			if (!key) {
				console.error("Usage: bunflare r2 object get <key> [--bucket NAME]");
				process.exit(1);
			}
			const obj = await bucket.get(key);
			if (!obj) {
				console.error(`Object not found: ${key}`);
				process.exit(1);
			}
			if ("arrayBuffer" in obj) {
				const data = await obj.arrayBuffer();
				process.stdout.write(new Uint8Array(data));
			}
			break;
		}
		case "put": {
			const key = args[2];
			const filePath = parseFlag(ctx.args, "--file");
			if (!key || !filePath) {
				console.error("Usage: bunflare r2 object put <key> --file <path> [--bucket NAME]");
				process.exit(1);
			}
			const data = await Bun.file(filePath).arrayBuffer();
			await bucket.put(key, data);
			console.log(`Uploaded ${key} (${formatSize(data.byteLength)})`);
			break;
		}
		case "delete": {
			const key = args[2];
			if (!key) {
				console.error("Usage: bunflare r2 object delete <key> [--bucket NAME]");
				process.exit(1);
			}
			await bucket.delete(key);
			console.log(`Deleted ${key}`);
			break;
		}
		default:
			console.error(`Usage: bunflare r2 object <list|get|put|delete> [options]`);
			process.exit(1);
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
