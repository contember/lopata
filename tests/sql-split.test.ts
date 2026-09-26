import { describe, expect, test } from 'bun:test'
import { mayHaveMultipleStatements, splitStatements } from '../src/bindings/sql-split'

describe('splitStatements', () => {
	test('splits on semicolons outside literals and comments', () => {
		expect(splitStatements('SELECT \'a;b\'; -- x;y\nSELECT "c;d"; /* ; */ SELECT 3')).toEqual([
			"SELECT 'a;b'",
			'SELECT "c;d"',
			'SELECT 3',
		])
	})

	test('keeps backtick and bracket quoted names intact', () => {
		expect(splitStatements('SELECT 1 AS `a;b`; SELECT 2 AS [c;d]')).toEqual(['SELECT 1 AS `a;b`', 'SELECT 2 AS [c;d]'])
	})

	test('keeps a trigger body together, including CASE … END inside it', () => {
		const trigger = 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET x = CASE WHEN new.y THEN 1 ELSE 0 END; INSERT INTO log VALUES (1); END'
		expect(splitStatements(`${trigger}; SELECT 1`)).toEqual([trigger, 'SELECT 1'])
	})

	test('an END inside a literal does not close a trigger', () => {
		const trigger = "CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('END'); END"
		expect(splitStatements(`${trigger};SELECT 1`)).toEqual([trigger, 'SELECT 1'])
	})
})

describe('mayHaveMultipleStatements', () => {
	test('a single statement, with or without trailing semicolons, is not multi', () => {
		expect(mayHaveMultipleStatements('SELECT 1')).toBe(false)
		expect(mayHaveMultipleStatements('SELECT 1;  ;\n')).toBe(false)
	})

	test('anything after a semicolon makes it a candidate', () => {
		expect(mayHaveMultipleStatements('SELECT 1; SELECT 2')).toBe(true)
	})
})
