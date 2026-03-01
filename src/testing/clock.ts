export interface Clock {
	now(): number
}

export const realClock: Clock = { now: () => Date.now() }

export class TestClock implements Clock {
	private _now: number

	constructor(startTime?: number | Date) {
		this._now = startTime instanceof Date ? startTime.getTime() : (startTime ?? Date.now())
	}

	now(): number {
		return this._now
	}

	advance(ms: number): void {
		if (ms < 0) throw new Error('Cannot advance clock by negative amount')
		this._now += ms
	}

	set(time: number | Date): void {
		this._now = time instanceof Date ? time.getTime() : time
	}
}
