import type { CliContext } from "./context";
import { parseFlag } from "./context";
import { join } from "node:path";

export async function run(ctx: CliContext) {
	const args: string[] = [join(import.meta.dir, "../dev.ts")];

	const port = parseFlag(ctx.args, "--port");
	if (port) args.push("--port", port);

	const listen = parseFlag(ctx.args, "--listen");
	if (listen) args.push("--listen", listen);

	const env = parseFlag(ctx.args, "--env") ?? parseFlag(ctx.args, "-e");
	if (env) args.push("--env", env);

	const proc = Bun.spawn(["bun", ...args], {
		stdio: ["inherit", "inherit", "inherit"],
	});

	process.on("SIGINT", () => proc.kill());
	process.on("SIGTERM", () => proc.kill());

	await proc.exited;
	process.exit(proc.exitCode ?? 0);
}
