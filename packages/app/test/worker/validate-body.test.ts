/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Tests for the validateBodyMiddleware.
 *
 * These tests verify that invalid request bodies are rejected with HTTP 400
 * and that valid bodies pass through to the handler.
 *
 * The middleware is registered globally in `worker/index.ts` and uses
 * `c.req.routePath` to look up the compiled ajv schema for the matched route.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

describe('validateBodyMiddleware — POST /api/signup', () => {
	test('valid body passes through (returns non-400 or domain error)', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'testuser', password: 'password123' }),
		}, env);
		// Should not be rejected by the middleware (400 from middleware has specific error key)
		if (res.status === 400) {
			const body = await res.json() as Record<string, unknown>;
			expect(body.error).not.toBe('validation error');
		} else {
			expect([200, 201, 409]).toContain(res.status);
		}
	});

	test('missing required field (password) returns 400 with validation error', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'testuser' }),
		}, env);
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('validation error');
		expect(Array.isArray(body.details)).toBe(true);
	});

	test('missing required field (username) returns 400 with validation error', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('validation error');
	});

	test('password shorter than minLength returns 400 with validation error', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'testuser', password: 'short' }),
		}, env);
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('validation error');
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

describe('validateBodyMiddleware — POST /api/buckets/create', () => {
	test('missing bucketName returns 400 with validation error', async () => {
		const { token } = await setupUser();
		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('validation error');
	});

	test('valid body passes (returns 200 or domain error, not validation error)', async () => {
		const { token } = await setupUser();
		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);
		if (res.status === 400) {
			const body = await res.json() as Record<string, unknown>;
			expect(body.error).not.toBe('validation error');
		} else {
			expect([200, 201]).toContain(res.status);
		}
	});
});

describe('validateBodyMiddleware — non-JSON content types are skipped', () => {
	test('multipart/form-data is not validated and passes to handler', async () => {
		// The upload endpoint accepts multipart; the middleware should skip it
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'multipart/form-data; boundary=abc' },
			body: '--abc--',
		}, env);
		// Middleware should skip; response should NOT be "validation error"
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).not.toBe('validation error');
	});
});

describe('validateBodyMiddleware — GET requests are skipped', () => {
	test('GET request is not validated', async () => {
		const res = await app.request('/api/meta', {
			method: 'GET',
		}, env);
		// Should respond normally
		expect(res.status).toBe(200);
	});
});

// Helper: create a user and return a token
async function setupUser(): Promise<{ token: string }> {
	const { data } = await signup('testuser');
	return { token: String(data.token) };
}
