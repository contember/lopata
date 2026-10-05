import type { Database, SQLQueryBindings } from 'bun:sqlite'

export type WorkflowStepType = 'do' | 'sleep' | 'waitForEvent'
export type WorkflowStepMethod = WorkflowStepType | 'sleepUntil'
export interface WorkflowStepKey {
	type: WorkflowStepType
	name: string
	count: number
}
export interface WorkflowRestartOptions {
	from?: { name: string; count?: number; type?: WorkflowStepType }
	fromStep?: string
}
export interface WorkflowExecutionToken {
	instanceId: string
	workflowName: string
	incarnation: string
	run: number
	epoch: number
}
export type WorkflowCheckpoint = { kind: 'undefined' } | { kind: 'json'; serialized: string }
export interface WorkflowStoredError {
	name: string
	message: string
	nonRetryable: boolean
	errorId: string | null
}
export interface WorkflowOccurrenceInput {
	key: WorkflowStepKey
	method: WorkflowStepMethod
	startOrder: number
	rollbackRegistered: boolean
}
export interface WorkflowOccurrenceRef {
	token: WorkflowExecutionToken
	occurrenceId: number
}
export interface WorkflowOccurrenceRecord {
	id: number
	key: WorkflowStepKey
	method: WorkflowStepMethod
	startOrder: number
	state: 'started' | 'completed' | 'failed'
	checkpoint: WorkflowCheckpoint | null
	deadline: number | null
	eventType: string | null
	completedAt: number | null
	attempt: number
	failedAttempts: number
	error: WorkflowStoredError | null
	updatedAt: number | null
	rollbackRegistered: boolean
	rollbackState: 'running' | 'complete' | 'failed' | null
	rollbackAttempts: number
	rollbackError: WorkflowStoredError | null
}
interface InstanceRow {
	id: string
	workflow_name: string
	incarnation: string
	run: number
	execution_epoch: number
	persistence_version: number
}
interface OccurrenceRow {
	id: number
	type: string
	name: string
	count: number
	method: string
	start_order: number
	state: string
	deadline: number | null
	event_type: string | null
	output_kind: string | null
	output: string | null
	completed_at: number | null
	attempt: number
	failed_attempts: number
	error: string | null
	error_name: string | null
	non_retryable: number
	last_error_id: string | null
	updated_at: number | null
	rollback_registered: number
	rollback_state: string | null
	rollback_attempts: number
	rollback_error: string | null
	rollback_error_name: string | null
}
interface LegacyHistory {
	start_order: number
	state: string
	attempt: number
	error: string | null
	error_name: string | null
	non_retryable: number
	rollback_registered: number
	rollback_state: string | null
	rollback_attempts: number
	rollback_error: string | null
	rollback_error_name: string | null
}
export interface WorkflowLegacyRecord {
	resolved: false
	history: LegacyHistory | null
	step_name: string
	output: string | null
	completed_at: number | null
	failed_attempts: number
	last_error: string | null
	last_error_name: string | null
	last_error_id: string | null
	updated_at: number | null
}
export interface WorkflowDetailRecords {
	occurrences: WorkflowOccurrenceRecord[]
	legacy: WorkflowLegacyRecord[]
}

export function legacyStepName(method: WorkflowStepMethod, name: string): string {
	return method === 'do' ? name : `${method}:${name}`
}

export function decodeWorkflowEvent<T>(checkpoint: WorkflowCheckpoint): { payload: T; timestamp: Date; type: string } {
	if (checkpoint.kind !== 'json') throw new Error('Invalid stored workflow event checkpoint')
	const event: { payload: T; timestamp: unknown; type: unknown } | null = JSON.parse(checkpoint.serialized)
	if (!event || typeof event !== 'object' || typeof event.timestamp !== 'string' || typeof event.type !== 'string') {
		throw new Error('Invalid stored workflow event checkpoint')
	}
	const timestamp = new Date(event.timestamp)
	if (!Number.isFinite(timestamp.getTime())) throw new Error('Invalid stored workflow event timestamp')
	return { payload: event.payload, timestamp, type: event.type }
}

function parseOccurrence(row: OccurrenceRow): WorkflowOccurrenceRecord {
	if (typeof row.name !== 'string') throw new Error('Invalid stored workflow step name')
	if (row.type !== 'do' && row.type !== 'sleep' && row.type !== 'waitForEvent') throw new Error('Invalid stored workflow step type')
	if (row.method !== 'do' && row.method !== 'sleep' && row.method !== 'sleepUntil' && row.method !== 'waitForEvent') {
		throw new Error('Invalid stored workflow step method')
	}
	if ((row.method === 'sleepUntil' ? 'sleep' : row.method) !== row.type) throw new Error('Invalid stored workflow method/type pair')
	if (row.state !== 'started' && row.state !== 'completed' && row.state !== 'failed') throw new Error('Invalid stored workflow step state')
	if (row.rollback_state !== null && row.rollback_state !== 'running' && row.rollback_state !== 'complete' && row.rollback_state !== 'failed') {
		throw new Error('Invalid stored workflow rollback state')
	}
	for (const value of [row.id, row.count, row.start_order, row.attempt]) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid stored workflow occurrence identity')
	}
	for (const value of [row.failed_attempts, row.rollback_attempts]) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid stored workflow attempt count')
	}
	for (const value of [row.deadline, row.completed_at, row.updated_at]) {
		if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid stored workflow timestamp')
	}
	for (const value of [row.error, row.error_name, row.last_error_id, row.rollback_error, row.rollback_error_name, row.event_type]) {
		if (value !== null && typeof value !== 'string') throw new Error('Invalid stored workflow text field')
	}
	let checkpoint: WorkflowCheckpoint | null = null
	if (row.output_kind === 'undefined' && row.output === null) checkpoint = { kind: 'undefined' }
	else if (row.output_kind === 'json' && typeof row.output === 'string') {
		JSON.parse(row.output)
		checkpoint = { kind: 'json', serialized: row.output }
	} else if (row.output_kind !== null || row.output !== null) throw new Error('Invalid stored workflow checkpoint')
	if (row.state === 'completed' && checkpoint === null) {
		throw new Error(`Completed workflow occurrence ${row.id} (${row.type} "${row.name}" #${row.count}) has no checkpoint`)
	}
	if ((row.non_retryable !== 0 && row.non_retryable !== 1) || (row.rollback_registered !== 0 && row.rollback_registered !== 1)) {
		throw new Error('Invalid stored workflow flags')
	}
	return {
		id: row.id,
		key: { type: row.type, name: row.name, count: row.count },
		method: row.method,
		startOrder: row.start_order,
		state: row.state,
		checkpoint,
		deadline: row.deadline,
		eventType: row.event_type,
		completedAt: row.completed_at,
		attempt: row.attempt,
		failedAttempts: row.failed_attempts,
		error: row.error === null
			? null
			: { message: row.error, name: row.error_name ?? 'Error', nonRetryable: row.non_retryable === 1, errorId: row.last_error_id },
		updatedAt: row.updated_at,
		rollbackRegistered: row.rollback_registered === 1,
		rollbackState: row.rollback_state,
		rollbackAttempts: row.rollback_attempts,
		rollbackError: row.rollback_error === null
			? null
			: { message: row.rollback_error, name: row.rollback_error_name ?? 'Error', nonRetryable: false, errorId: null },
	}
}

export class WorkflowStore {
	constructor(private db: Database) {}

	currentToken(instanceId: string, workflowName?: string): WorkflowExecutionToken {
		const row = this.db.query<InstanceRow, [string]>('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId)
		if (!row || (workflowName !== undefined && row.workflow_name !== workflowName)) throw new Error(`Workflow instance ${instanceId} not found`)
		if (
			typeof row.incarnation !== 'string' || !row.incarnation || !Number.isSafeInteger(row.run) || row.run < 1
			|| !Number.isSafeInteger(row.execution_epoch) || row.execution_epoch < 0 || typeof row.workflow_name !== 'string'
			|| (row.persistence_version !== 0 && row.persistence_version !== 1)
		) {
			throw new Error('Invalid stored workflow execution identity')
		}
		return { instanceId, workflowName: row.workflow_name, incarnation: row.incarnation, run: row.run, epoch: row.execution_epoch }
	}

	assertCurrent(token: WorkflowExecutionToken): void {
		const current = this.currentToken(token.instanceId, token.workflowName)
		if (current.incarnation !== token.incarnation || current.run !== token.run || current.epoch !== token.epoch) {
			throw new Error('Stale workflow execution')
		}
	}

	transaction<T>(token: WorkflowExecutionToken, operation: () => T): T {
		return this.db.transaction(() => {
			this.assertCurrent(token)
			return operation()
		}).immediate()
	}

	acquireExecution(instanceId: string, workflowName: string): WorkflowExecutionToken {
		return this.fenceExecution(this.currentToken(instanceId, workflowName))
	}

	fenceExecution(token: WorkflowExecutionToken): WorkflowExecutionToken {
		return this.transaction(token, () => {
			this.db.query('UPDATE workflow_instances SET execution_epoch = execution_epoch + 1 WHERE id = ?').run(token.instanceId)
			return { ...token, epoch: token.epoch + 1 }
		})
	}

	readOccurrence(ref: WorkflowOccurrenceRef): WorkflowOccurrenceRecord {
		this.assertCurrent(ref.token)
		const row = this.db.query<OccurrenceRow, [number, string, number]>(
			'SELECT * FROM workflow_occurrences WHERE id = ? AND incarnation = ? AND run = ?',
		).get(ref.occurrenceId, ref.token.incarnation, ref.token.run)
		if (!row) throw new Error('Workflow occurrence not found')
		return parseOccurrence(row)
	}

	openOccurrence(token: WorkflowExecutionToken, input: WorkflowOccurrenceInput): WorkflowOccurrenceRecord {
		return this.transaction(token, () => {
			const existing = this.db.query<OccurrenceRow, [string, number, string, string, number]>(
				'SELECT * FROM workflow_occurrences WHERE incarnation = ? AND run = ? AND type = ? AND name = ? AND count = ?',
			).get(token.incarnation, token.run, input.key.type, input.key.name, input.key.count)
			if (existing) {
				if (existing.method !== input.method || existing.start_order !== input.startOrder) {
					throw new Error('Workflow occurrence replay order/method changed')
				}
				return parseOccurrence(existing)
			}
			const inserted = this.db.query(`INSERT INTO workflow_occurrences (incarnation, run, type, name, count, method, start_order, rollback_registered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
				token.incarnation,
				token.run,
				input.key.type,
				input.key.name,
				input.key.count,
				input.method,
				input.startOrder,
				input.rollbackRegistered ? 1 : 0,
			)
			const ref = { token, occurrenceId: Number(inserted.lastInsertRowid) }
			this.adoptLegacy(ref, input)
			return this.readOccurrence(ref)
		})
	}

	private adoptLegacy(ref: WorkflowOccurrenceRef, input: WorkflowOccurrenceInput): void {
		const { token } = ref
		const version = this.db.query<{ persistence_version: number }, [string]>('SELECT persistence_version FROM workflow_instances WHERE id = ?').get(
			token.instanceId,
		)
		if (version?.persistence_version !== 0) return
		const rawKey = legacyStepName(input.method, input.key.name)
		const claim = this.db.query<{ occurrence_id: number }, [string, string]>(
			'SELECT occurrence_id FROM workflow_legacy_claims WHERE incarnation = ? AND raw_key = ?',
		).get(token.incarnation, rawKey)
		if (claim) {
			const claimed = this.readOccurrence({ token, occurrenceId: claim.occurrence_id })
			if (claimed.method !== input.method || claimed.key.name !== input.key.name || claimed.key.type !== input.key.type) {
				throw new Error(`Ambiguous legacy workflow key "${rawKey}": already claimed by another step type/method`)
			}
			return
		}
		const cached = this.db.query<{ output: string | null; completed_at: number }, [string, string]>(
			'SELECT output, completed_at FROM workflow_steps WHERE instance_id = ? AND step_name = ?',
		).get(token.instanceId, rawKey)
		const history = this.db.query<LegacyHistory, [string, string]>('SELECT * FROM workflow_step_history WHERE instance_id = ? AND step_name = ?').get(
			token.instanceId,
			rawKey,
		)
		const attempts = this.db.query<
			{ failed_attempts: number; last_error: string | null; last_error_name: string | null; last_error_id: string | null; updated_at: number | null },
			[string, string]
		>(
			'SELECT * FROM workflow_step_attempts WHERE instance_id = ? AND step_name = ?',
		).get(token.instanceId, rawKey)
		if (!cached && !history && !attempts) return
		if (history && input.method !== 'do') throw new Error(`Ambiguous legacy workflow key "${rawKey}": saved do history conflicts with ${input.method}`)
		if (history) {
			const conflicting = this.db.query<{ raw_key: string }, [string, number]>(
				'SELECT raw_key FROM workflow_legacy_claims WHERE incarnation = ? AND history_order >= ? LIMIT 1',
			).get(token.incarnation, history.start_order)
			if (conflicting) throw new Error(`Ambiguous legacy workflow order at "${rawKey}"`)
		}
		let deadline: number | null = null
		if (cached && input.key.type === 'sleep') {
			const value: unknown = JSON.parse(cached.output ?? 'null')
			if (!value || typeof value !== 'object' || !('until' in value) || (typeof value.until !== 'string' && typeof value.until !== 'number')) {
				throw new Error(`Ambiguous legacy sleep checkpoint "${rawKey}"`)
			}
			deadline = typeof value.until === 'number' ? value.until : Date.parse(value.until)
			if (!Number.isFinite(deadline)) throw new Error(`Invalid legacy sleep deadline "${rawKey}"`)
		}
		this.db.query(
			`UPDATE workflow_occurrences SET state = ?, output_kind = ?, output = ?, completed_at = ?, deadline = ?, attempt = ?, failed_attempts = ?,
			error = ?, error_name = ?, non_retryable = ?, last_error_id = ?, updated_at = ?, rollback_registered = ?, rollback_state = ?, rollback_attempts = ?, rollback_error = ?, rollback_error_name = ? WHERE id = ?`,
		)
			.run(
				cached && input.key.type !== 'sleep' ? 'completed' : history?.state ?? 'started',
				cached && input.key.type !== 'sleep' ? cached.output === null ? 'undefined' : 'json' : null,
				input.key.type === 'sleep' ? null : cached?.output ?? null,
				input.key.type === 'sleep' ? null : cached?.completed_at ?? null,
				deadline,
				history?.attempt ?? 1,
				attempts?.failed_attempts ?? 0,
				history?.error ?? attempts?.last_error ?? null,
				history?.error_name ?? attempts?.last_error_name ?? null,
				history?.non_retryable ?? 0,
				attempts?.last_error_id ?? null,
				attempts?.updated_at ?? null,
				history?.rollback_registered ?? (input.rollbackRegistered ? 1 : 0),
				history?.rollback_state ?? null,
				history?.rollback_attempts ?? 0,
				history?.rollback_error ?? null,
				history?.rollback_error_name ?? null,
				ref.occurrenceId,
			)
		this.db.query('INSERT INTO workflow_legacy_claims (incarnation, raw_key, occurrence_id, history_order) VALUES (?, ?, ?, ?)')
			.run(token.incarnation, rawKey, ref.occurrenceId, history?.start_order ?? null)
	}

	private update(ref: WorkflowOccurrenceRef, assignments: string, values: SQLQueryBindings[]): void {
		this.transaction(ref.token, () => {
			this.readOccurrence(ref)
			this.db.query(`UPDATE workflow_occurrences SET ${assignments} WHERE id = ?`).run(...values, ref.occurrenceId)
		})
	}

	readCheckpoint(ref: WorkflowOccurrenceRef): WorkflowCheckpoint | null {
		return this.readOccurrence(ref).checkpoint
	}
	startAttempt(ref: WorkflowOccurrenceRef, attempt: number): void {
		this.update(ref, 'attempt = ?', [attempt])
	}
	recordAttemptFailure(ref: WorkflowOccurrenceRef, failedAttempts: number, error: WorkflowStoredError, at: number): void {
		this.update(ref, 'failed_attempts = ?, error = ?, error_name = ?, non_retryable = ?, last_error_id = ?, updated_at = ?', [
			failedAttempts,
			error.message,
			error.name,
			error.nonRetryable ? 1 : 0,
			error.errorId,
			at,
		])
	}
	commitCheckpoint(ref: WorkflowOccurrenceRef, checkpoint: WorkflowCheckpoint, at: number): void {
		this.update(
			ref,
			"state = 'completed', output_kind = ?, output = ?, completed_at = ?, failed_attempts = 0, error = NULL, error_name = NULL, non_retryable = 0, last_error_id = NULL",
			[checkpoint.kind, checkpoint.kind === 'json' ? checkpoint.serialized : null, at],
		)
	}
	failOccurrence(ref: WorkflowOccurrenceRef, error: WorkflowStoredError, at: number): void {
		this.update(ref, "state = 'failed', error = ?, error_name = ?, non_retryable = ?, updated_at = ?", [
			error.message,
			error.name,
			error.nonRetryable ? 1 : 0,
			at,
		])
	}
	setDeadline(ref: WorkflowOccurrenceRef, deadline: number, eventType: string | null): number {
		return this.transaction(ref.token, () => {
			const record = this.readOccurrence(ref)
			const savedDeadline = record.deadline ?? deadline
			if (!Number.isFinite(savedDeadline)) throw new Error('Invalid workflow deadline')
			if (record.eventType !== null && record.eventType !== eventType) throw new Error('Workflow event type changed during replay')
			this.update(ref, 'deadline = COALESCE(deadline, ?), event_type = ?', [savedDeadline, eventType])
			return savedDeadline
		})
	}
	completeSleep(ref: WorkflowOccurrenceRef, at: number): void {
		this.commitCheckpoint(ref, { kind: 'undefined' }, at)
	}

	enqueueEvent(token: WorkflowExecutionToken, eventType: string, serialized: string | null, at: number): void {
		this.transaction(token, () => {
			const row = this.db.query<{ status: string }, [string]>('SELECT status FROM workflow_instances WHERE id = ?').get(token.instanceId)
			if (!row || ['complete', 'errored', 'terminated'].includes(row.status)) {
				throw new Error(`Cannot send event to workflow instance "${token.instanceId}" with status "${row?.status ?? 'missing'}"`)
			}
			this.db.query('INSERT INTO workflow_events (instance_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)')
				.run(token.instanceId, eventType, serialized, at)
		})
	}

	consumeEvent(ref: WorkflowOccurrenceRef, at: number): WorkflowCheckpoint | null {
		return this.transaction(ref.token, () => {
			const record = this.readOccurrence(ref)
			if (record.checkpoint) return record.checkpoint
			if (record.deadline === null) throw new Error('Missing workflow wait deadline')
			const first = this.db.query<{ id: number }, [string, number, string | null]>(
				"SELECT id FROM workflow_occurrences WHERE incarnation = ? AND run = ? AND type = 'waitForEvent' AND event_type = ? AND state = 'started' ORDER BY start_order LIMIT 1",
			).get(ref.token.incarnation, ref.token.run, record.eventType)
			if (first?.id !== ref.occurrenceId) return null
			const event = this.db.query<{ id: number; payload: string | null; created_at: number }, [string, string | null, number]>(
				'SELECT id, payload, created_at FROM workflow_events WHERE instance_id = ? AND event_type = ? AND created_at <= ? ORDER BY id LIMIT 1',
			).get(ref.token.instanceId, record.eventType, record.deadline)
			if (!event) return null
			const checkpoint: WorkflowCheckpoint = {
				kind: 'json',
				serialized: JSON.stringify({
					payload: event.payload === null ? undefined : JSON.parse(event.payload),
					timestamp: new Date(event.created_at).toISOString(),
					type: record.eventType,
				}),
			}
			this.commitCheckpoint(ref, checkpoint, at)
			this.db.query('DELETE FROM workflow_events WHERE id = ?').run(event.id)
			return checkpoint
		})
	}
	listRollbackOccurrences(token: WorkflowExecutionToken): WorkflowOccurrenceRecord[] {
		this.assertCurrent(token)
		return this.db.query<OccurrenceRow, [string, number]>(
			'SELECT * FROM workflow_occurrences WHERE incarnation = ? AND run = ? AND rollback_registered = 1 ORDER BY start_order DESC',
		)
			.all(token.incarnation, token.run).map(parseOccurrence)
	}
	startRollbackAttempt(ref: WorkflowOccurrenceRef): void {
		this.update(ref, "rollback_state = 'running'", [])
	}
	recordRollbackFailure(ref: WorkflowOccurrenceRef, failedAttempts: number, error: WorkflowStoredError): void {
		this.update(ref, 'rollback_attempts = ?, rollback_error = ?, rollback_error_name = ?', [failedAttempts, error.message, error.name])
	}
	finishRollback(ref: WorkflowOccurrenceRef, outcome: 'complete' | 'failed'): void {
		this.update(ref, 'rollback_state = ?', [outcome])
	}
	resolveRestartTarget(token: WorkflowExecutionToken, from: WorkflowStepKey): number {
		this.assertCurrent(token)
		const record = this.db.query<{ start_order: number }, [string, number, string, string, number]>(
			'SELECT start_order FROM workflow_occurrences WHERE incarnation = ? AND run = ? AND type = ? AND name = ? AND count = ?',
		)
			.get(token.incarnation, token.run, from.type, from.name, from.count)
		if (!record) {
			throw new Error(
				`Step "${from.name}" (${from.type} #${from.count}) not found; legacy identity/order must be resolved by replay before targeted restart`,
			)
		}
		return record.start_order
	}
	replaceRun(token: WorkflowExecutionToken, fromOrder: number | null): WorkflowExecutionToken {
		return this.transaction(token, () => {
			this.db.query('DELETE FROM workflow_legacy_claims WHERE incarnation = ?').run(token.incarnation)
			this.db.query('DELETE FROM workflow_occurrences WHERE incarnation = ? AND (start_order >= ? OR output_kind IS NULL)').run(
				token.incarnation,
				fromOrder ?? 0,
			)
			this.db.query(
				`UPDATE workflow_occurrences SET run = ?, failed_attempts = 0, error = NULL, error_name = NULL, last_error_id = NULL, non_retryable = 0,
				rollback_state = NULL, rollback_attempts = 0, rollback_error = NULL, rollback_error_name = NULL WHERE incarnation = ?`,
			).run(token.run + 1, token.incarnation)
			this.removeLegacy(token.instanceId)
			this.db.query(
				"UPDATE workflow_instances SET run = run + 1, execution_epoch = execution_epoch + 1, persistence_version = 1, status = 'running', output = NULL, error = NULL, error_name = NULL, updated_at = ? WHERE id = ?",
			).run(Date.now(), token.instanceId)
			return { ...token, run: token.run + 1, epoch: token.epoch + 1 }
		})
	}
	readDetail(instanceId: string, workflowName: string): WorkflowDetailRecords {
		const token = this.currentToken(instanceId, workflowName)
		const occurrences = this.db.query<OccurrenceRow, [string, number]>(
			'SELECT * FROM workflow_occurrences WHERE incarnation = ? AND run = ? ORDER BY start_order',
		).all(token.incarnation, token.run).map(parseOccurrence)
		const legacy = this.db.query<Omit<WorkflowLegacyRecord, 'resolved' | 'history'>, [string, string, string, string, string]>(
			`SELECT keys.step_name, s.output, s.completed_at, COALESCE(a.failed_attempts, 0) AS failed_attempts, a.last_error, a.last_error_name, a.last_error_id, a.updated_at
			FROM (SELECT step_name FROM workflow_steps WHERE instance_id = ? UNION SELECT step_name FROM workflow_step_attempts WHERE instance_id = ? UNION SELECT step_name FROM workflow_step_history WHERE instance_id = ?) keys
			LEFT JOIN workflow_steps s ON s.instance_id = ?1 AND s.step_name = keys.step_name
			LEFT JOIN workflow_step_attempts a ON a.instance_id = ?1 AND a.step_name = keys.step_name
			WHERE NOT EXISTS (SELECT 1 FROM workflow_legacy_claims c WHERE c.incarnation = ?4 AND c.raw_key = keys.step_name)
			AND EXISTS (SELECT 1 FROM workflow_instances WHERE id = ?5 AND persistence_version = 0)`,
		)
			.all(instanceId, instanceId, instanceId, token.incarnation, instanceId).map((row): WorkflowLegacyRecord => ({
				...row,
				resolved: false,
				history: this.db.query<LegacyHistory, [string, string]>('SELECT * FROM workflow_step_history WHERE instance_id = ? AND step_name = ?').get(
					instanceId,
					row.step_name,
				),
			}))
		return { occurrences, legacy }
	}
	private removeLegacy(instanceId: string): void {
		for (const table of ['workflow_steps', 'workflow_step_attempts', 'workflow_step_history', 'workflow_rollbacks', 'workflow_events']) {
			this.db.query(`DELETE FROM ${table} WHERE instance_id = ?`).run(instanceId)
		}
	}
	removeOwnedState(instanceId: string, workflowName: string): void {
		const token = this.currentToken(instanceId, workflowName)
		this.transaction(token, () => {
			this.db.query('DELETE FROM workflow_legacy_claims WHERE incarnation = ?').run(token.incarnation)
			this.db.query('DELETE FROM workflow_occurrences WHERE incarnation = ?').run(token.incarnation)
			this.removeLegacy(instanceId)
			this.db.query('DELETE FROM workflow_instances WHERE id = ?').run(instanceId)
		})
	}
}
