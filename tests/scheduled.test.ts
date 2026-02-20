import { describe, expect, test } from 'bun:test'
import { createScheduledController, cronMatchesDate, parseCron } from '../src/bindings/scheduled'

describe('parseCron', () => {
	test('parses every-minute cron', () => {
		const cron = parseCron('* * * * *')
		// Should match any date
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 5, 15, 12, 30))).toBe(true)
	})

	test('parses specific values', () => {
		const cron = parseCron('5 14 1 6 3')
		// June 1 2025 is a Sunday (day 0), not Wednesday (day 3)
		expect(cronMatchesDate(cron, new Date(2025, 5, 1, 14, 5))).toBe(false)
		// June 4 2025 is a Wednesday
		expect(cronMatchesDate(cron, new Date(2025, 5, 4, 14, 5))).toBe(false) // day is 4, not 1
	})

	test('parses ranges', () => {
		const cron = parseCron('1-5 * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 1))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 3))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 5))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 6))).toBe(false)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(false)
	})

	test('parses comma-separated values', () => {
		const cron = parseCron('0,15,30,45 * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 15))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 30))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 45))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 10))).toBe(false)
	})

	test('parses step values with wildcard', () => {
		const cron = parseCron('*/15 * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 15))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 30))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 45))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 7))).toBe(false)
	})

	test('parses step values with range', () => {
		const cron = parseCron('1-10/3 * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 1))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 4))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 7))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 10))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 2))).toBe(false)
	})

	test('throws on invalid expression (wrong number of fields)', () => {
		expect(() => parseCron('* * *')).toThrow('Invalid cron expression')
	})

	test('preserves original expression', () => {
		const cron = parseCron('*/5 * * * *')
		expect(cron.expression).toBe('*/5 * * * *')
	})

	test('@daily expands to 0 0 * * *', () => {
		const cron = parseCron('@daily')
		expect(cron.expression).toBe('@daily')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 12, 0))).toBe(false)
		expect(cronMatchesDate(cron, new Date(2025, 5, 15, 0, 0))).toBe(true)
	})

	test('@midnight is same as @daily', () => {
		const cron = parseCron('@midnight')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 1, 0))).toBe(false)
	})

	test('@hourly expands to 0 * * * *', () => {
		const cron = parseCron('@hourly')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 5, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 5, 1))).toBe(false)
	})

	test('@weekly expands to 0 0 * * 0', () => {
		const cron = parseCron('@weekly')
		// 2025-01-05 is a Sunday (day 0)
		expect(cronMatchesDate(cron, new Date(2025, 0, 5, 0, 0))).toBe(true)
		// 2025-01-06 is a Monday
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(false)
	})

	test('@monthly expands to 0 0 1 * *', () => {
		const cron = parseCron('@monthly')
		expect(cronMatchesDate(cron, new Date(2025, 2, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 2, 2, 0, 0))).toBe(false)
	})

	test('@yearly expands to 0 0 1 1 *', () => {
		const cron = parseCron('@yearly')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 1, 1, 0, 0))).toBe(false)
	})

	test('@annually is same as @yearly', () => {
		const a = parseCron('@annually')
		const y = parseCron('@yearly')
		const d1 = new Date(2025, 0, 1, 0, 0)
		const d2 = new Date(2025, 5, 15, 12, 30)
		expect(cronMatchesDate(a, d1)).toBe(cronMatchesDate(y, d1))
		expect(cronMatchesDate(a, d2)).toBe(cronMatchesDate(y, d2))
	})

	test('parses day-of-week names', () => {
		const cron = parseCron('0 0 * * MON')
		// 2025-01-06 is a Monday
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 7, 0, 0))).toBe(false)
	})

	test('parses day-of-week name range', () => {
		const cron = parseCron('0 0 * * MON-FRI')
		// 2025-01-06 Mon, 07 Tue, 08 Wed, 09 Thu, 10 Fri, 11 Sat, 12 Sun
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 10, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 11, 0, 0))).toBe(false)
		expect(cronMatchesDate(cron, new Date(2025, 0, 12, 0, 0))).toBe(false)
	})

	test('parses month names', () => {
		const cron = parseCron('0 0 1 JAN *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 1, 1, 0, 0))).toBe(false)
	})

	test('parses month name range', () => {
		const cron = parseCron('0 0 1 MAR-JUN *')
		expect(cronMatchesDate(cron, new Date(2025, 2, 1, 0, 0))).toBe(true) // Mar
		expect(cronMatchesDate(cron, new Date(2025, 5, 1, 0, 0))).toBe(true) // Jun
		expect(cronMatchesDate(cron, new Date(2025, 1, 1, 0, 0))).toBe(false) // Feb
		expect(cronMatchesDate(cron, new Date(2025, 6, 1, 0, 0))).toBe(false) // Jul
	})

	test('parses comma-separated day names', () => {
		const cron = parseCron('0 0 * * MON,WED,FRI')
		// 2025-01-06 Mon, 07 Tue, 08 Wed, 09 Thu, 10 Fri
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(true) // Mon
		expect(cronMatchesDate(cron, new Date(2025, 0, 8, 0, 0))).toBe(true) // Wed
		expect(cronMatchesDate(cron, new Date(2025, 0, 10, 0, 0))).toBe(true) // Fri
		expect(cronMatchesDate(cron, new Date(2025, 0, 7, 0, 0))).toBe(false) // Tue
	})

	test('day/month names are case-insensitive', () => {
		const cron = parseCron('0 0 * jan sun')
		// 2025-01-05 is a Sunday in January
		expect(cronMatchesDate(cron, new Date(2025, 0, 5, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(false)
	})

	test('special strings are case-insensitive', () => {
		const cron = parseCron('@DAILY')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 12, 0))).toBe(false)
	})
})

describe('cronMatchesDate', () => {
	test('every-minute matches any date', () => {
		const cron = parseCron('* * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 5, 15, 12, 30))).toBe(true)
	})

	test('specific minute matches only that minute', () => {
		const cron = parseCron('30 * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 30))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(false)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 12, 30))).toBe(true)
	})

	test('specific hour matches only that hour', () => {
		const cron = parseCron('0 14 * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 14, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 15, 0))).toBe(false)
	})

	test('specific day of month', () => {
		const cron = parseCron('0 0 15 * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 15, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 14, 0, 0))).toBe(false)
	})

	test('specific month', () => {
		const cron = parseCron('0 0 1 6 *')
		expect(cronMatchesDate(cron, new Date(2025, 5, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(false)
	})

	test('specific day of week', () => {
		const cron = parseCron('0 0 * * 1')
		// 2025-01-06 is a Monday (day 1)
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(true)
		// 2025-01-07 is a Tuesday (day 2)
		expect(cronMatchesDate(cron, new Date(2025, 0, 7, 0, 0))).toBe(false)
	})

	test('every 5 minutes', () => {
		const cron = parseCron('*/5 * * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 5))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 3))).toBe(false)
	})

	test('midnight daily', () => {
		const cron = parseCron('0 0 * * *')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 1, 0))).toBe(false)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 1))).toBe(false)
	})

	test('day name MON matches Monday', () => {
		const cron = parseCron('0 0 * * MON')
		expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 7, 0, 0))).toBe(false)
	})

	test('month name JUN matches June', () => {
		const cron = parseCron('0 0 1 JUN *')
		expect(cronMatchesDate(cron, new Date(2025, 5, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(false)
	})

	test('@daily matches midnight', () => {
		const cron = parseCron('@daily')
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 1, 12, 0))).toBe(false)
	})
})

describe('Extended cron syntax: L, W, #', () => {
	test('L in day-of-month — last day of month', () => {
		const cron = parseCron('0 0 L * *')
		// January 31
		expect(cronMatchesDate(cron, new Date(2025, 0, 31, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 30, 0, 0))).toBe(false)
		// February 28 (non-leap year 2025)
		expect(cronMatchesDate(cron, new Date(2025, 1, 28, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 1, 27, 0, 0))).toBe(false)
		// February 29 (leap year 2024)
		expect(cronMatchesDate(cron, new Date(2024, 1, 29, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2024, 1, 28, 0, 0))).toBe(false)
	})

	test('W in day-of-month — nearest weekday', () => {
		const cron = parseCron('0 0 15W * *')
		// 2025-01-15 is a Wednesday — exact match
		expect(cronMatchesDate(cron, new Date(2025, 0, 15, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 14, 0, 0))).toBe(false)

		// 2025-02-15 is Saturday → nearest weekday is Friday Feb 14
		expect(cronMatchesDate(cron, new Date(2025, 1, 14, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 1, 15, 0, 0))).toBe(false)

		// 2025-06-15 is Sunday → nearest weekday is Monday Jun 16
		expect(cronMatchesDate(cron, new Date(2025, 5, 16, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 5, 15, 0, 0))).toBe(false)
	})

	test('LW in day-of-month — last weekday of month', () => {
		const cron = parseCron('0 0 LW * *')
		// January 2025: 31st is a Friday → last weekday is 31
		expect(cronMatchesDate(cron, new Date(2025, 0, 31, 0, 0))).toBe(true)
		// February 2025: 28th is a Friday → last weekday is 28
		expect(cronMatchesDate(cron, new Date(2025, 1, 28, 0, 0))).toBe(true)
		// March 2025: 31st is a Monday → last weekday is 31
		expect(cronMatchesDate(cron, new Date(2025, 2, 31, 0, 0))).toBe(true)
	})

	test('# in day-of-week — Nth occurrence', () => {
		// 2#3 = 3rd Tuesday of the month
		const cron = parseCron('0 0 * * 2#3')
		// January 2025: Tuesdays are 7, 14, 21, 28 → 3rd Tuesday is 21st
		expect(cronMatchesDate(cron, new Date(2025, 0, 21, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 14, 0, 0))).toBe(false)
		expect(cronMatchesDate(cron, new Date(2025, 0, 28, 0, 0))).toBe(false)
	})

	test('L in day-of-week — last occurrence of weekday', () => {
		// 5L = last Friday of the month
		const cron = parseCron('0 0 * * 5L')
		// January 2025: Fridays are 3, 10, 17, 24, 31 → last Friday is 31st
		expect(cronMatchesDate(cron, new Date(2025, 0, 31, 0, 0))).toBe(true)
		expect(cronMatchesDate(cron, new Date(2025, 0, 24, 0, 0))).toBe(false)
		// February 2025: Fridays are 7, 14, 21, 28 → last Friday is 28th
		expect(cronMatchesDate(cron, new Date(2025, 1, 28, 0, 0))).toBe(true)
	})
})

describe('ScheduledController', () => {
	test('has scheduledTime and cron properties', () => {
		const now = Date.now()
		const controller = createScheduledController('*/5 * * * *', now)
		expect(controller.scheduledTime).toBe(now)
		expect(controller.cron).toBe('*/5 * * * *')
	})

	test('noRetry is callable (no-op in dev)', () => {
		const controller = createScheduledController('* * * * *', Date.now())
		expect(() => controller.noRetry()).not.toThrow()
	})

	test("type property returns 'scheduled'", () => {
		const controller = createScheduledController('* * * * *', Date.now())
		expect(controller.type).toBe('scheduled')
	})
})
