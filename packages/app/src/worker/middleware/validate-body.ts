/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Hono middleware: validate JSON request body against the OpenAPI-like schema
 * definitions in `worker/api/*.definition.ts`.
 *
 * - Only inspects POST/PUT/PATCH requests whose Content-Type is application/json.
 * - multipart/form-data (file upload) requests are intentionally skipped.
 * - On validation failure, responds with HTTP 400 and a JSON error body.
 *
 * ajv instances are compiled once at module load time to avoid paying the
 * compilation cost on every request.
 *
 * ## Why URLPattern instead of c.req.routePath
 * This middleware is registered globally via `app.use('*', ...)`. At that
 * point Hono has not yet resolved the matched route handler, so
 * `c.req.routePath` returns the global wildcard pattern ('*') rather than
 * the concrete route path (e.g. '/api/admin/set-user-quota/:userId').
 *
 * URLPattern (available in Cloudflare Workers) lets us test the real request
 * URL against each registered route pattern ourselves, replicating the same
 * path-matching logic without depending on Hono's internal routing state.
 */

import Ajv from 'ajv';
import { createMiddleware } from 'hono/factory';
import type { Schema } from '../api/schema-type';
import { schemaToJsonSchema } from '../utils/schema-to-ajv';

// --- schema imports --------------------------------------------------------

import { adminApiSchema } from '../api/admin.definition';
import { authApiSchema } from '../api/auth.definition';
import { bucketsApiSchema } from '../api/buckets.definition';
import { filesApiSchema } from '../api/files.definition';
import { fileTokensApiSchema } from '../api/file-tokens.definition';
import { metaApiSchema } from '../api/meta.definition';

// ---------------------------------------------------------------------------

type ApiDefinition = {
	path: string;
	method: string;
	requestBody?: {
		'application/json'?: Schema;
		[key: string]: unknown;
	};
};

const METHODS_WITH_BODY = new Set(['post', 'put', 'patch']);

/**
 * Convert a Hono-style path pattern (e.g. `/api/admin/set-user-quota/:userId`)
 * to a URLPattern pathname string (e.g. `/api/admin/set-user-quota/:userId`).
 *
 * URLPattern uses the same `:param` syntax as Hono, so no transformation is
 * needed for simple named parameters.  Wildcard `*` is converted to `{*}`.
 */
function honoPathToUrlPattern(path: string): string {
	// Replace bare * wildcards with URLPattern's {*} syntax
	return path.replace(/\*/g, '{*}');
}

type ValidatorEntry = {
	pattern: URLPattern;
	validate: ReturnType<Ajv['compile']>;
};

/**
 * Build a list of `{ pattern, validate }` pairs for every definition that has
 * an `application/json` requestBody schema.
 *
 * The list is keyed by HTTP method (lowercase) so we can avoid checking
 * patterns whose method never matches.
 */
function buildValidatorList(
	definitions: readonly ApiDefinition[],
	ajv: Ajv,
): Map<string, ValidatorEntry[]> {
	const map = new Map<string, ValidatorEntry[]>();

	for (const def of definitions) {
		const method = def.method.toLowerCase();
		if (!METHODS_WITH_BODY.has(method)) continue;

		const jsonSchema = def.requestBody?.['application/json'];
		if (jsonSchema == null) continue;

		const fullSchema = schemaToJsonSchema(jsonSchema as Schema);
		const validate = ajv.compile(fullSchema);

		const pattern = new URLPattern({ pathname: honoPathToUrlPattern(def.path) });

		const list = map.get(method) ?? [];
		list.push({ pattern, validate });
		map.set(method, list);
	}

	return map;
}

// Initialise ajv once. `coerceTypes` is intentionally left off so that
// type mismatches (e.g. string instead of integer) are caught.
const ajv = new Ajv({ allErrors: true });

const allDefinitions: readonly ApiDefinition[] = [
	...adminApiSchema,
	...authApiSchema,
	...bucketsApiSchema,
	...filesApiSchema,
	...fileTokensApiSchema,
	...metaApiSchema,
] as ApiDefinition[];

const validatorsByMethod = buildValidatorList(allDefinitions, ajv);

// ---------------------------------------------------------------------------

export const validateBodyMiddleware = createMiddleware(async (c, next) => {
	const method = c.req.method.toLowerCase();
	if (!METHODS_WITH_BODY.has(method)) {
		await next();
		return;
	}

	const contentType = c.req.header('content-type') ?? '';
	// Skip multipart/form-data (file uploads) and other non-JSON content
	if (!contentType.includes('application/json')) {
		await next();
		return;
	}

	// Find the first validator whose URLPattern matches the request path
	const requestPath = c.req.path;
	const entries = validatorsByMethod.get(method);
	const entry = entries?.find((e) => e.pattern.test({ pathname: requestPath }));

	if (entry == null) {
		// No schema found for this endpoint — pass through
		await next();
		return;
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	if (!entry.validate(body)) {
		return c.json(
			{
				error: 'validation error',
				details: entry.validate.errors,
			},
			400,
		);
	}

	await next();
});
