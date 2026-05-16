/*
 * SPDX-FileCopyrightText: tamaina / syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// https://github.com/misskey-dev/misskey/blob/e2335567005ccd6e45db1556ae1095bb00d87e52/packages/backend/src/misc/id/aidx.ts

/*
 * EAID-X
 * base36(0を-で置き換え)
 * 長さ9の[2000年1月1日からの経過ミリ秒]-長さ4の[個体ID]-長さ4の[個体ID]長さ2の[カウンタ]
 */

import { customAlphabet } from 'nanoid';

export const aidxRegExp = /^[-1-9a-z]{9}-[-1-9a-z]{4}-[-1-9a-z]{4}$/;

const TIME2000 = 946684800000;
const TIME_LENGTH = 9;
const NODE_LENGTH = 4;
const NODE2_LENGTH = 2;
const NOISE_LENGTH = 2;
const AIDX_LENGTH = TIME_LENGTH + 1 + NODE_LENGTH + 1 + NODE2_LENGTH + NOISE_LENGTH;

const nodeId = customAlphabet('-123456789abcdefghijklmnopqrstuvwxyz', NODE_LENGTH)();
const nodeId2 = customAlphabet('-123456789abcdefghijklmnopqrstuvwxyz', NODE2_LENGTH)();
let counter = 0;

export function parseBigInt36(str: string): bigint {
	// log_36(Number.MAX_SAFE_INTEGER) => 10.251599391715352
	// so we process 10 chars at once
	const chunks = [];
	let remaining = str;
	while (remaining.length > 0) {
		chunks.unshift(remaining.slice(-10));
		remaining = remaining.slice(0, -10);
	}
	let result = 0n;
	for (const chunk of chunks) {
		result *= 36n ** 10n;
		const int = parseInt(chunk, 36);
		if (Number.isNaN(int)) {
			throw new Error('Invalid base36 string');
		}
		result += BigInt(int);
	}
	return result;
}

function getTime(time: number): string {
	const t = Math.max(0, time - TIME2000);

	return t.toString(36).replaceAll('0', '-').padStart(TIME_LENGTH, '-').slice(-TIME_LENGTH);
}

function getNoise(): string {
	return counter.toString(36).replaceAll('0', '-').padStart(NOISE_LENGTH, '-').slice(-NOISE_LENGTH);
}

export function genEaidx(t: number): string {
	if (isNaN(t)) throw new Error('Failed to create AIDX: Invalid Date');
	counter++;
	return `${getTime(t)}-${nodeId}-${nodeId2}${getNoise()}`;
}

export function parseEaidx(id: string): { date: Date; } {
	const time = parseInt(id.slice(0, TIME_LENGTH).replaceAll('-', '0'), 36) + TIME2000;
	return { date: new Date(time) };
}

export function parseEaidxFull(id: string): { date: number; additional: bigint; } {
	const date = parseInt(id.slice(0, TIME_LENGTH).replaceAll('-', '0'), 36) + TIME2000;
	const additional = parseBigInt36(id.slice(TIME_LENGTH + 1, AIDX_LENGTH).replaceAll('-', '0'));
	return { date, additional };
}

export function isSafeEaidxT(t: number): boolean {
	return t > TIME2000;
}
