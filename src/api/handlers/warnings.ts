import type { OptionalDep } from '../../warnings'
import { getOptionalDeps } from '../../warnings'

export const handlers = {
	'warnings.optionalDeps'(_input: {}): OptionalDep[] {
		return getOptionalDeps()
	},
}
