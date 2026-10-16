import { plugin } from 'bun'
import type { ModuleRule } from './config'

/** Wrangler's built-in rules. They apply after the worker's own `rules`. */
export const DEFAULT_MODULE_RULES: ModuleRule[] = [
	{ type: 'Text', globs: ['**/*.txt', '**/*.html', '**/*.sql'] },
	{ type: 'Data', globs: ['**/*.bin'] },
	{ type: 'CompiledWasm', globs: ['**/*.wasm', '**/*.wasm?module'] },
]

export interface ParsedModuleRules {
	/** Rules in match order. */
	rules: ModuleRule[]
	/** Rules shadowed by an earlier rule of the same type without `fallthrough: true`. An import they match is an error. */
	removedRules: ModuleRule[]
}

/**
 * Wrangler's rule merge: the worker's rules, then the defaults. The first rule of a type
 * ends that type unless it sets `fallthrough: true`; later rules of the type are removed.
 */
export function parseModuleRules(userRules: ModuleRule[] = []): ParsedModuleRules {
	const rules: ModuleRule[] = []
	const removedRules: ModuleRule[] = []
	const closedTypes = new Set<string>()
	for (const rule of [...userRules, ...DEFAULT_MODULE_RULES]) {
		if (closedTypes.has(rule.type)) {
			removedRules.push(rule)
			continue
		}
		rules.push(rule)
		if (rule.fallthrough !== true) closedTypes.add(rule.type)
	}
	return { rules, removedRules }
}

const ESCAPED_GLOB_CHARS = new Set(['/', '$', '^', '+', '.', '(', ')', '=', '!', '|', '?', '[', ']', '{', '}', ','])

/**
 * A glob as wrangler compiles it (`glob-to-regexp` with default options): `*` and `**` match
 * any characters including `/`, every other character is literal, and the whole path must match.
 */
export function globToRegExp(glob: string): RegExp {
	let source = ''
	for (let i = 0; i < glob.length; i++) {
		const char = glob.charAt(i)
		if (char === '*') {
			while (glob.charAt(i + 1) === '*') i++
			source += '.*'
		} else if (ESCAPED_GLOB_CHARS.has(char)) {
			source += `\\${char}`
		} else {
			source += char
		}
	}
	return new RegExp(`^${source}$`)
}

type LoadedModuleType = 'Text' | 'Data' | 'CompiledWasm'

interface RuleMatcher {
	regex: RegExp
	rule: ModuleRule
	type: LoadedModuleType
	removed: boolean
}

function loadedModuleType(rule: ModuleRule): LoadedModuleType | null {
	if (rule.type === 'Text' || rule.type === 'Data' || rule.type === 'CompiledWasm') return rule.type
	// ESModule / CommonJS are JavaScript, which Bun loads itself; Python modules do not run on Bun.
	return null
}

function toMatchers(rules: ModuleRule[], removed: boolean): RuleMatcher[] {
	const matchers: RuleMatcher[] = []
	for (const rule of rules) {
		const type = loadedModuleType(rule)
		if (!type) continue
		for (const glob of rule.globs) matchers.push({ regex: globToRegExp(glob), rule, type, removed })
	}
	return matchers
}

async function loadModuleValue(type: LoadedModuleType, filePath: string): Promise<unknown> {
	const file = Bun.file(filePath)
	if (type === 'Text') return file.text()
	if (type === 'Data') return file.arrayBuffer()
	return new WebAssembly.Module(await file.arrayBuffer())
}

/**
 * Load imports matched by the worker's wrangler `rules` (plus the defaults) the way
 * Cloudflare does: Text → string, Data → ArrayBuffer, CompiledWasm → WebAssembly.Module,
 * each as the default export. Globs are tested against the imported file's absolute path,
 * including a query such as `?module`.
 *
 * Bun plugins are per thread, so every thread that imports user code registers this
 * before its first import of the worker module.
 */
export function registerModuleRules(userRules: ModuleRule[] | undefined): void {
	const { rules, removedRules } = parseModuleRules(userRules)
	const matchers = [...toMatchers(rules, false), ...toMatchers(removedRules, true)]
	const filter = new RegExp(matchers.map(m => `(?:${m.regex.source})`).join('|'))
	plugin({
		name: 'lopata:module-rules',
		setup(build) {
			build.onLoad({ filter }, async args => {
				const matcher = matchers.find(m => m.regex.test(args.path))
				if (!matcher) throw new Error(`[lopata] module rules: no rule matches ${args.path}`)
				if (matcher.removed) {
					throw new Error(
						`The file ${args.path} matched a module rule in your configuration (${JSON.stringify(matcher.rule)}), `
							+ 'but was ignored because a previous rule with the same type was not marked as `fallthrough = true`.',
					)
				}
				const filePath = args.path.replace(/\?.*$/, '')
				return { exports: { default: await loadModuleValue(matcher.type, filePath) }, loader: 'object' }
			})
		},
	})
}
