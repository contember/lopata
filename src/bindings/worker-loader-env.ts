/**
 * Wire format of a Worker Loader `env` (shared by the host and the dynamic worker's thread).
 *
 * workerd serializes `env` like an RPC payload: structured-clonable data plus Fetchers
 * (service bindings and `ctx.exports` loopbacks specialized with props). The data is
 * structured-cloned into the dynamic worker; each Fetcher stays with the host and is
 * replaced by a placeholder naming its slot, which the dynamic worker turns into a stub
 * that calls back into the host.
 */

import type { SerializedError, SerializedRequest } from '../worker-thread/protocol'

export const ENV_FETCHER_KEY = '__lopata_loader_fetcher'

export interface EnvFetcherPlaceholder {
	[ENV_FETCHER_KEY]: number
}

/** dynamic worker → host: a call on the Fetcher in `slot`. */
export type LoaderEnvRequest =
	| { type: 'env-call'; id: number; slot: number; method: string; args: unknown[] }
	| { type: 'env-get'; id: number; slot: number; property: string }
	| { type: 'env-fetch'; id: number; slot: number; request: SerializedRequest }

export type LoaderEnvResult =
	| { type: 'value'; value: unknown }
	| { type: 'response'; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'error'; error: SerializedError }

/** host → dynamic worker: the answer to a {@link LoaderEnvRequest}. */
export interface LoaderEnvReply {
	type: 'env-result'
	id: number
	result: LoaderEnvResult
}
