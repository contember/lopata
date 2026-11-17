import { type Env, handleIncrement } from '../../shared'

export { Counter } from '../../shared'

export default {
	fetch(_request: Request, env: Env): Promise<Response> {
		return handleIncrement(env)
	},
}
