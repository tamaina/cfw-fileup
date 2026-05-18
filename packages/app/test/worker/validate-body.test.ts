/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Tests for request body validation via hono-openapi/valibot validator.
 *
 * Each route handler registers a `validator('json', schema)` middleware that
 * rejects invalid bodies with HTTP 400 before the handler runs.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

describe('valibot validator — POST /api/signup', () => {
	test('valid body passes through (returns non-400 or domain error)', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'testuser', password: 'password123' }),
		}, env);
		expect([200, 201, 409]).toContain(res.status);
	});

	test('missing required field (password) returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'testuser' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('missing required field (username) returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('password shorter than minLength returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'testuser', password: 'short' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('invalid JSON returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not-valid-json',
		}, env);
		expect(res.status).toBe(400);
	});
});

describe('valibot validator — POST /api/buckets/create', () => {
	test('missing bucketName returns 400', async () => {
		const { token } = await setupUser();
		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('valid body passes (returns 200/201 or domain error, not validation error)', async () => {
		const { token } = await setupUser();
		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'mybucket' }),
		}, env);
		expect([200, 201]).toContain(res.status);
	});
});

describe('valibot validator — GET requests are skipped', () => {
	test('GET /api/meta responds normally', async () => {
		const res = await app.request('/api/meta', {
			method: 'GET',
		}, env);
		expect(res.status).toBe(200);
	});
});

// Helper: create a user and return a token
async function setupUser(): Promise<{ token: string }> {
	const { data } = await signup('testuser');
	return { token: String(data.token) };
}
