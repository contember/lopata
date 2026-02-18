/**
 * Local implementation of the Cloudflare Workers AI binding.
 * Proxies requests to the Cloudflare AI API and logs them to SQLite.
 */
import type { Database } from "bun:sqlite";

const MAX_LOG_SIZE = 1024;

function truncate(value: unknown): string {
	const str = typeof value === "string" ? value : JSON.stringify(value);
	if (!str) return "";
	return str.length > MAX_LOG_SIZE ? str.slice(0, MAX_LOG_SIZE) + "…" : str;
}

export class AiBinding {
	private readonly db: Database;
	private readonly accountId?: string;
	private readonly apiToken?: string;
	aiGatewayLogId: string | null = null;

	constructor(db: Database, accountId?: string, apiToken?: string) {
		this.db = db;
		this.accountId = accountId;
		this.apiToken = apiToken;
	}

	private ensureCredentials(): { accountId: string; apiToken: string } {
		if (!this.accountId || !this.apiToken) {
			throw new Error(
				"Workers AI requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .dev.vars",
			);
		}
		return { accountId: this.accountId, apiToken: this.apiToken };
	}

	async run(model: string, inputs: Record<string, unknown>, options?: { returnRawResponse?: boolean }): Promise<unknown> {
		const { accountId, apiToken } = this.ensureCredentials();
		const isStreaming = !!inputs.stream;
		const id = crypto.randomUUID();
		const start = Date.now();

		let status = "ok";
		let error: string | undefined;
		let outputSummary = "";

		try {
			const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(inputs),
			});

			if (!response.ok) {
				const text = await response.text();
				status = "error";
				error = `HTTP ${response.status}: ${text}`;
				throw new Error(error);
			}

			if (isStreaming) {
				outputSummary = "<streaming>";
				return response.body;
			}

			if (options?.returnRawResponse) {
				outputSummary = "<raw response>";
				return response;
			}

			const json = await response.json() as { result?: unknown };
			outputSummary = truncate(json.result);
			return json.result;
		} catch (err) {
			if (status !== "error") {
				status = "error";
				error = err instanceof Error ? err.message : String(err);
			}
			throw err;
		} finally {
			const duration = Date.now() - start;
			this.db.prepare(
				`INSERT INTO ai_requests (id, model, input_summary, output_summary, duration_ms, status, error, is_streaming, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				model,
				truncate(inputs),
				outputSummary,
				duration,
				status,
				error ?? null,
				isStreaming ? 1 : 0,
				start,
			);
		}
	}

	async models(params?: Record<string, string>): Promise<unknown[]> {
		const { accountId, apiToken } = this.ensureCredentials();
		const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}
		const response = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Workers AI models() failed: HTTP ${response.status}: ${text}`);
		}
		const json = await response.json() as { result?: unknown[] };
		return json.result ?? [];
	}

	gateway(_id: string): never {
		throw new Error("ai.gateway() is not supported in local dev mode");
	}

	autorag(_id: string): never {
		throw new Error("ai.autorag() is not supported in local dev mode");
	}

	toMarkdown(): never {
		throw new Error("ai.toMarkdown() is not supported in local dev mode");
	}
}
