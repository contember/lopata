import { DurableObject } from 'cloudflare:workers'
import { type Env, handleIncrement } from '../../shared'

export { Counter } from '../../shared'

/** A class only this auxiliary worker hosts. */
export class Solo extends DurableObject {}

export default {
	fetch(_request: Request, env: Env): Promise<Response> {
		return handleIncrement(env)
	},
}
