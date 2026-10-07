export interface PurgeResult {
	success: boolean
	errors: { code: number; message: string }[]
}

export interface WorkerCacheApi {
	purge(options: unknown): Promise<PurgeResult>
	invalidate(options: unknown): Promise<PurgeResult>
}

// Local dev never caches entrypoint responses, so there is nothing to purge or invalidate.
export const cache: WorkerCacheApi = {
	async purge() {
		return { success: true, errors: [] }
	},
	async invalidate() {
		return { success: true, errors: [] }
	},
}
