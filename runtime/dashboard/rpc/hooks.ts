import { useEffect, useRef, useState } from 'preact/hooks'
import { rpc } from './client'
import type { Procedures } from './server'
import type { Paginated } from './types'

type EmptyObject = Record<string, never>

// ─── useQuery ────────────────────────────────────────────────────────

interface QueryResult<T> {
	data: T | null
	isLoading: boolean
	error: Error | null
	refetch: () => void
}

export function useQuery<K extends keyof Procedures>(
	procedure: K,
	...args: Procedures[K]['input'] extends EmptyObject ? [] : [Procedures[K]['input']]
): QueryResult<Procedures[K]['output']> {
	type Output = Procedures[K]['output']
	const [state, setState] = useState<{ data: Output | null; isLoading: boolean; error: Error | null }>({
		data: null,
		isLoading: true,
		error: null,
	})
	const input = args[0]
	const key = JSON.stringify(input ?? {})
	const genRef = useRef(0)

	const doFetch = () => {
		const gen = ++genRef.current
		setState(s => ({ ...s, isLoading: true, error: null }))
		;(rpc as Function)(procedure, input)
			.then((data: Output) => {
				if (genRef.current === gen) setState({ data, isLoading: false, error: null })
			})
			.catch((err: unknown) => {
				if (genRef.current === gen) setState({ data: null, isLoading: false, error: toError(err) })
			})
	}

	useEffect(() => {
		doFetch()
	}, [doFetch])

	return { ...state, refetch: doFetch }
}

// ─── usePaginatedQuery ───────────────────────────────────────────────

type PaginatedProcedures = {
	[K in keyof Procedures]: Procedures[K]['output'] extends Paginated<any> ? K : never
}[keyof Procedures]

type PaginatedItem<K extends PaginatedProcedures> = Procedures[K]['output'] extends Paginated<infer T> ? T : never

interface PaginatedQueryResult<T> {
	items: T[]
	isLoading: boolean
	hasMore: boolean
	loadMore: () => void
	refetch: () => void
}

export function usePaginatedQuery<K extends PaginatedProcedures>(
	procedure: K,
	input: Omit<Procedures[K]['input'], 'cursor'>,
): PaginatedQueryResult<PaginatedItem<K>> {
	type Item = PaginatedItem<K>
	const [items, setItems] = useState<Item[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const cursorRef = useRef<string | null>(null)
	const [hasMore, setHasMore] = useState(false)
	const key = JSON.stringify(input)

	const load = (reset: boolean) => {
		setIsLoading(true)
		const fullInput = { ...input, cursor: reset ? '' : (cursorRef.current ?? '') }
		;(rpc as Function)(procedure, fullInput).then((data: Paginated<Item>) => {
			setItems(prev => reset ? data.items : [...prev, ...data.items])
			cursorRef.current = data.cursor
			setHasMore(data.cursor !== null)
			setIsLoading(false)
		})
	}

	useEffect(() => {
		cursorRef.current = null
		load(true)
	}, [load])

	return { items, isLoading, hasMore, loadMore: () => load(false), refetch: () => load(true) }
}

// ─── useMutation ─────────────────────────────────────────────────────

interface MutationResult<Input, Output> {
	mutate: (...args: Input extends EmptyObject ? [] : [Input]) => Promise<Output | undefined>
	data: Output | null
	isLoading: boolean
	error: Error | null
	reset: () => void
}

export function useMutation<K extends keyof Procedures>(
	procedure: K,
): MutationResult<Procedures[K]['input'], Procedures[K]['output']> {
	type Output = Procedures[K]['output']
	const [state, setState] = useState<{ data: Output | null; isLoading: boolean; error: Error | null }>({
		data: null,
		isLoading: false,
		error: null,
	})

	const mutate = async (...args: any[]): Promise<Output | undefined> => {
		setState({ data: null, isLoading: true, error: null })
		try {
			const result = await (rpc as Function)(procedure, args[0])
			setState({ data: result, isLoading: false, error: null })
			return result
		} catch (err) {
			setState({ data: null, isLoading: false, error: toError(err) })
			return undefined
		}
	}

	const reset = () => setState({ data: null, isLoading: false, error: null })

	return { ...state, mutate: mutate as MutationResult<Procedures[K]['input'], Output>['mutate'], reset }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err))
}
