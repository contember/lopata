import type { CliContext } from "./context";
import { parseFlag } from "./context";
import { FileR2Bucket } from "../bindings/r2";

/**
 * Parse wrangler-compatible objectPath in the form {bucket}/{key}.
 * If there's no slash, the whole string is the bucket name (for list).
 */
function parseObjectPath(objectPath: string): { bucketName: string; key: string } {
	const idx = objectPath.indexOf("/");
	if (idx === -1) return { bucketName: objectPath, key: "" };
	return { bucketName: objectPath.slice(0, idx), key: objectPath.slice(idx + 1) };
}

/**
 * Resolve bucket name: check it exists in config, return the config entry's bucket_name.
 */
function resolveBucket(
	buckets: { binding: string; bucket_name: string }[] | undefined,
	bucketName: string,
): string {
	if (!buckets || buckets.length === 0) {
		console.error("No R2 buckets configured.");
		process.exit(1);
	}
	// Match by bucket_name or binding name
	const match = buckets.find(b => b.bucket_name === bucketName || b.binding === bucketName);
	if (!match) {
		const names = buckets.map(b => b.bucket_name).join(", ");
		console.error(`R2 bucket "${bucketName}" not found. Available: ${names}`);
		process.exit(1);
	}
	return match.bucket_name;
}

export async function run(ctx: CliContext, args: string[]) {
	const sub = args[0];
	if (sub !== "object") {
		console.error(`Usage: bunflare r2 object <list|get|put|delete> <bucket/key>`);
		process.exit(1);
	}

	const action = args[1];
	const objectPath = args[2];
	const config = await ctx.config();

	switch (action) {
		case "list": {
			if (!objectPath) {
				// No path — list all buckets if no path given
				const buckets = config.r2_buckets ?? [];
				if (buckets.length === 0) {
					console.log("No R2 buckets configured.");
					return;
				}
				for (const b of buckets) {
					console.log(`${b.bucket_name}  binding=${b.binding}`);
				}
				return;
			}
			const { bucketName, key: prefix } = parseObjectPath(objectPath);
			const resolved = resolveBucket(config.r2_buckets, bucketName);
			const bucket = new FileR2Bucket(ctx.db(), resolved, ctx.dataDir());
			const listPrefix = parseFlag(ctx.args, "--prefix") ?? prefix;
			let cursor = "";
			let total = 0;
			do {
				const result = await bucket.list({ prefix: listPrefix, cursor: cursor || undefined });
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
			if (!objectPath || !objectPath.includes("/")) {
				console.error("Usage: bunflare r2 object get <bucket/key>");
				process.exit(1);
			}
			const { bucketName, key } = parseObjectPath(objectPath);
			const resolved = resolveBucket(config.r2_buckets, bucketName);
			const bucket = new FileR2Bucket(ctx.db(), resolved, ctx.dataDir());
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
			if (!objectPath || !objectPath.includes("/")) {
				console.error("Usage: bunflare r2 object put <bucket/key> --file <path>");
				process.exit(1);
			}
			const filePath = parseFlag(ctx.args, "--file") ?? parseFlag(ctx.args, "-f");
			if (!filePath) {
				console.error("Usage: bunflare r2 object put <bucket/key> --file <path>");
				process.exit(1);
			}
			const { bucketName, key } = parseObjectPath(objectPath);
			const resolved = resolveBucket(config.r2_buckets, bucketName);
			const bucket = new FileR2Bucket(ctx.db(), resolved, ctx.dataDir());
			const data = await Bun.file(filePath).arrayBuffer();
			await bucket.put(key, data);
			console.log(`Uploaded ${key} (${formatSize(data.byteLength)})`);
			break;
		}
		case "delete": {
			if (!objectPath || !objectPath.includes("/")) {
				console.error("Usage: bunflare r2 object delete <bucket/key>");
				process.exit(1);
			}
			const { bucketName, key } = parseObjectPath(objectPath);
			const resolved = resolveBucket(config.r2_buckets, bucketName);
			const bucket = new FileR2Bucket(ctx.db(), resolved, ctx.dataDir());
			await bucket.delete(key);
			console.log(`Deleted ${key}`);
			break;
		}
		default:
			console.error(`Usage: bunflare r2 object <list|get|put|delete> <bucket/key>`);
			process.exit(1);
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
