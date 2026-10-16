import { describe, expect, test } from 'bun:test'
import type { ModuleRule } from '../src/config'
import { DEFAULT_MODULE_RULES, globToRegExp, parseModuleRules } from '../src/module-rules'

const defaultsOfType = (type: ModuleRule['type']) => DEFAULT_MODULE_RULES.filter(rule => rule.type === type)
const defaultsExcept = (type: ModuleRule['type']) => DEFAULT_MODULE_RULES.filter(rule => rule.type !== type)

describe('parseModuleRules', () => {
	test('without worker rules, the defaults apply', () => {
		expect(parseModuleRules()).toEqual({ rules: DEFAULT_MODULE_RULES, removedRules: [] })
	})

	test('a worker rule of a default type replaces that default', () => {
		const markdown: ModuleRule = { type: 'Text', globs: ['**/*.md'] }
		expect(parseModuleRules([markdown])).toEqual({ rules: [markdown, ...defaultsExcept('Text')], removedRules: defaultsOfType('Text') })
	})

	test('fallthrough: true keeps the later rules of the same type', () => {
		const markdown: ModuleRule = { type: 'Text', globs: ['**/*.md'], fallthrough: true }
		expect(parseModuleRules([markdown])).toEqual({ rules: [markdown, ...DEFAULT_MODULE_RULES], removedRules: [] })
	})

	test('rules of other types are independent', () => {
		const data: ModuleRule = { type: 'Data', globs: ['**/*.dat'] }
		const { rules, removedRules } = parseModuleRules([data])
		expect(rules).toEqual([data, ...defaultsExcept('Data')])
		expect(removedRules).toEqual(defaultsOfType('Data'))
	})
})

describe('globToRegExp', () => {
	test('** and * match across directories, like wrangler', () => {
		const regex = globToRegExp('**/*.md')
		expect(regex.test('/project/src/prompts/agent.md')).toBe(true)
		expect(regex.test('/project/src/agent.mdx')).toBe(false)
	})

	test('? and . are literal', () => {
		const regex = globToRegExp('**/*.wasm?module')
		expect(regex.test('/project/src/add.wasm?module')).toBe(true)
		expect(regex.test('/project/src/add.wasmXmodule')).toBe(false)
		expect(globToRegExp('**/*.txt').test('/project/a_txt')).toBe(false)
	})
})
