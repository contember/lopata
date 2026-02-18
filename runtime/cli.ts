#!/usr/bin/env bun

import { createContext, hasFlag } from "./cli/context";

const ctx = createContext(process.argv);
const args = ctx.args;

// Strip global flags to find the command
const globalFlags = ["--config", "-c", "--env", "-e"];
const commandArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (globalFlags.includes(args[i]!)) {
		i++; // skip flag value
		continue;
	}
	commandArgs.push(args[i]!);
}

const command = commandArgs[0];
const subcommand = commandArgs[1];

if (!command || hasFlag(args, "--help") || hasFlag(args, "-h")) {
	printHelp();
	process.exit(0);
}

switch (command) {
	case "dev": {
		const mod = await import("./cli/dev");
		await mod.run(ctx);
		break;
	}
	case "d1": {
		const mod = await import("./cli/d1");
		await mod.run(ctx, commandArgs.slice(1));
		break;
	}
	case "r2": {
		const mod = await import("./cli/r2");
		await mod.run(ctx, commandArgs.slice(1));
		break;
	}
	case "kv": {
		const mod = await import("./cli/kv");
		await mod.run(ctx, commandArgs.slice(1));
		break;
	}
	case "queues": {
		const mod = await import("./cli/queues");
		await mod.run(ctx, commandArgs.slice(1));
		break;
	}
	case "cache": {
		const mod = await import("./cli/cache");
		await mod.run(ctx, commandArgs.slice(1));
		break;
	}
	default:
		console.error(`Unknown command: ${command}`);
		printHelp();
		process.exit(1);
}

function printHelp() {
	console.log(`
bunflare — local Cloudflare Worker dev tools

Usage: bunflare <command> [options]

Commands:
  dev                         Start local dev server
  d1 list                     List D1 databases
  d1 execute <db> --command   Execute SQL on a D1 database
  d1 migrations apply [db]    Apply D1 migrations
  r2 object list              List R2 objects
  r2 object get <key>         Get an R2 object
  r2 object put <key> --file  Upload a file to R2
  r2 object delete <key>      Delete an R2 object
  kv key list                 List KV keys
  kv key get <key>            Get a KV value
  kv key put <key> <value>    Put a KV value
  kv key delete <key>         Delete a KV key
  queues list                 List queues
  queues message list <queue> List queue messages
  queues message send <queue> Send a message to a queue
  queues message purge <queue> Purge queue messages
  cache list                  List cache names
  cache purge [--name CACHE]  Purge cache entries

Global flags:
  --config, -c <path>   Path to wrangler config file
  --env, -e <name>      Environment name
  --help, -h            Show this help
`.trim());
}
