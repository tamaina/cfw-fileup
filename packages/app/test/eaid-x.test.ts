/*
 * SPDX-FileCopyrightText: tamaina / syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect } from 'vitest';
import {
	aidxRegExp,
	parseBigInt36,
	genEaidx,
	parseEaidx,
	parseEaidxFull,
	isSafeEaidxT,
} from '../src/shared/eaid-x.js';

const TIME2000 = 946684800000;

describe('parseBigInt36', () => {
	test('0 → 0n', () => {
		expect(parseBigInt36('0')).toBe(0n);
	});

	test('1 → 1n', () => {
		expect(parseBigInt36('1')).toBe(1n);
	});

	test('z → 35n', () => {
		expect(parseBigInt36('z')).toBe(35n);
	});

	test('10 → 36n (one place higher)', () => {
		expect(parseBigInt36('10')).toBe(36n);
	});

	test('zzzzzzzzzz (10 chars) → 36^10 - 1', () => {
		expect(parseBigInt36('zzzzzzzzzz')).toBe(3656158440062975n);
	});

	test('10000000000 (11 chars) → 36^10, tests chunking', () => {
		expect(parseBigInt36('10000000000')).toBe(3656158440062976n);
	});

	test('invalid base36 string throws', () => {
		expect(() => parseBigInt36('!')).toThrow('Invalid base36 string');
	});
});

describe('aidxRegExp', () => {
	test('valid ID matches regexp', () => {
		const id = genEaidx(Date.now());
		expect(aidxRegExp.test(id)).toBe(true);
	});

	test('wrong length does not match', () => {
		expect(aidxRegExp.test('short')).toBe(false);
	});

	test('invalid separator position does not match', () => {
		expect(aidxRegExp.test('123456789_1234_1234')).toBe(false);
	});
});

describe('genEaidx', () => {
	test('returns a string of correct length (19 chars)', () => {
		const id = genEaidx(Date.now());
		expect(id).toHaveLength(19);
	});

	test('matches aidxRegExp', () => {
		const id = genEaidx(Date.now());
		expect(aidxRegExp.test(id)).toBe(true);
	});

	test('generated IDs are sorted by time', () => {
		const t1 = TIME2000 + 1000;
		const t2 = TIME2000 + 2000;
		const id1 = genEaidx(t1);
		const id2 = genEaidx(t2);
		expect(id1 < id2).toBe(true);
	});

	test('NaN throws', () => {
		expect(() => genEaidx(NaN)).toThrow('Failed to create AIDX: Invalid Date');
	});

	test('time before 2000 is clamped to 0 offset', () => {
		const id = genEaidx(0);
		const { date } = parseEaidx(id);
		expect(date.getTime()).toBe(TIME2000);
	});
});

describe('parseEaidx', () => {
	test('round-trip: parse gives back the original date (within 1 second)', () => {
		const t = TIME2000 + 123456789;
		const id = genEaidx(t);
		const { date } = parseEaidx(id);
		expect(date.getTime()).toBe(t);
	});

	test('returns a Date object', () => {
		const id = genEaidx(Date.now());
		const { date } = parseEaidx(id);
		expect(date).toBeInstanceOf(Date);
	});

	test('epoch 2000 (offset=0) gives DATE 2000-01-01', () => {
		const id = genEaidx(TIME2000);
		const { date } = parseEaidx(id);
		expect(date.getTime()).toBe(TIME2000);
	});
});

describe('parseEaidxFull', () => {
	test('round-trip: date matches original timestamp', () => {
		const t = TIME2000 + 987654321;
		const id = genEaidx(t);
		const { date } = parseEaidxFull(id);
		expect(date).toBe(t);
	});

	test('additional is a bigint', () => {
		const id = genEaidx(Date.now());
		const { additional } = parseEaidxFull(id);
		expect(typeof additional).toBe('bigint');
	});

	test('two IDs with same nodeId but different counter differ in additional', () => {
		const t = Date.now();
		const id1 = genEaidx(t);
		const id2 = genEaidx(t);
		const a1 = parseEaidxFull(id1).additional;
		const a2 = parseEaidxFull(id2).additional;
		expect(a1).not.toBe(a2);
	});
});

describe('isSafeEaidxT', () => {
	test('TIME2000 itself is not safe', () => {
		expect(isSafeEaidxT(TIME2000)).toBe(false);
	});

	test('TIME2000 + 1ms is safe', () => {
		expect(isSafeEaidxT(TIME2000 + 1)).toBe(true);
	});

	test('0 (before 2000) is not safe', () => {
		expect(isSafeEaidxT(0)).toBe(false);
	});

	test('current time is safe', () => {
		expect(isSafeEaidxT(Date.now())).toBe(true);
	});
});
