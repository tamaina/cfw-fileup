/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Converts the project's custom `Schema` type into a standard JSON Schema
 * that ajv can consume.
 *
 * The project's Schema has some non-standard fields:
 * - `optional: true`  → exclude the property key from the parent `required` array
 * - `nullable: true`  → add `'null'` to the `type` array
 * - `ref: keyof refs` → replace the schema with `{ $ref: '#/$defs/<ref>' }`
 */

import type { Schema } from '../api/schema-type';
import { refs } from '../api/schema-type';

// Standard JSON Schema object accepted by ajv
export type AjvJsonSchema = Record<string, unknown>;

/**
 * Build `$defs` entries for every key in `refs` so that `$ref` pointers work.
 * Each ref is itself converted recursively.
 */
function buildDefs(): Record<string, AjvJsonSchema> {
	const defs: Record<string, AjvJsonSchema> = {};
	for (const [key, refSchema] of Object.entries(refs)) {
		defs[key] = convertSchema(refSchema as Schema, false);
	}
	return defs;
}

/**
 * Recursively converts a single Schema node.
 *
 * @param schema - The Schema to convert.
 * @param _isProperty - Whether this schema is inside a `properties` map.
 *   (Reserved for future use; currently unused.)
 */
export function convertSchema(schema: Schema, _isProperty = false): AjvJsonSchema {
	// `ref` takes priority — replace entirely with a $ref pointer
	if (schema.ref != null) {
		return { $ref: `#/$defs/${schema.ref}` };
	}

	const result: AjvJsonSchema = {};

	// Copy scalar keywords that pass through unchanged
	for (const key of [
		'description', 'example', 'format', 'enum', 'default',
		'maxLength', 'minLength', 'maximum', 'minimum', 'pattern',
	] as const) {
		if (schema[key] !== undefined) {
			result[key] = schema[key];
		}
	}

	// `nullable: true` → add null to the type list
	if (schema.type !== undefined) {
		if (schema.nullable) {
			result.type = [schema.type === 'integer' ? 'integer' : schema.type, 'null'];
		} else {
			// ajv uses 'integer' directly; no mapping needed
			result.type = schema.type;
		}
	} else if (schema.nullable) {
		// No explicit type but nullable — just indicate null is accepted
		result.nullable = true;
	}

	// `properties` — recurse; build `required` from keys that are NOT `optional`
	if (schema.properties !== undefined) {
		const converted: Record<string, AjvJsonSchema> = {};
		const required: string[] = [];

		for (const [propKey, propSchema] of Object.entries(schema.properties)) {
			converted[propKey] = convertSchema(propSchema as Schema, true);
			if (!propSchema.optional) {
				required.push(propKey);
			}
		}
		result.properties = converted;

		// Merge with any explicit `required` array from the schema definition
		// (definition-level `required` overrides the property-level detection)
		if (schema.required !== undefined && schema.required.length > 0) {
			result.required = [...schema.required];
		} else if (required.length > 0) {
			result.required = required;
		}
	} else if (schema.required !== undefined) {
		result.required = [...schema.required];
	}

	// `items` — recurse for array item schema
	if (schema.items !== undefined) {
		result.items = convertSchema(schema.items as Schema);
	}

	// `prefixItems` — tuple validation
	if (schema.prefixItems !== undefined) {
		result.prefixItems = schema.prefixItems.map((s) => convertSchema(s as Schema));
	}

	// `unevaluatedItems`
	if (schema.unevaluatedItems !== undefined) {
		result.unevaluatedItems =
			typeof schema.unevaluatedItems === 'boolean'
				? schema.unevaluatedItems
				: convertSchema(schema.unevaluatedItems as Schema);
	}

	// Composition keywords
	if (schema.anyOf !== undefined) {
		result.anyOf = schema.anyOf.map((s) => convertSchema(s as Schema));
	}
	if (schema.oneOf !== undefined) {
		result.oneOf = schema.oneOf.map((s) => convertSchema(s as Schema));
	}
	if (schema.allOf !== undefined) {
		result.allOf = schema.allOf.map((s) => convertSchema(s as Schema));
	}

	// `additionalProperties`
	if (schema.additionalProperties !== undefined) {
		result.additionalProperties =
			typeof schema.additionalProperties === 'boolean'
				? schema.additionalProperties
				: convertSchema(schema.additionalProperties as Schema);
	}

	return result;
}

/**
 * Converts a top-level request-body `Schema` into a full JSON Schema document
 * including `$defs` so that all `$ref` pointers resolve correctly.
 */
export function schemaToJsonSchema(schema: Schema): AjvJsonSchema {
	const base = convertSchema(schema);
	return {
		...base,
		$defs: buildDefs(),
	};
}
