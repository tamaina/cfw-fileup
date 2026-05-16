/*
 * SPDX-FileCopyrightText: tamaina, syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// https://github.com/misskey-dev/misskey/blob/e2335567005ccd6e45db1556ae1095bb00d87e52/packages/backend/src/misc/json-schema.ts

export const refs = {
	Bucket: {
		type: 'object',
		properties: {
			id: { type: 'string' as const, description: 'Bucket ID' },
			name: { type: 'string' as const, description: 'Bucket name' },
			userId: { type: 'string' as const, description: 'Owner user ID' },
		},
		required: ['id', 'name', 'userId'],
	} as const,
	AppSetting: {
		type: 'object',
		properties: {
			key: { type: 'string' as const, description: 'Setting key' },
			value: { type: 'string' as const, description: 'Setting value' },
		},
		required: ['key', 'value'],
	} as const,
	OkResponse: {
		type: 'object',
		properties: { ok: { type: 'boolean' as const } },
		required: ['ok'],
	} as const,
	Quota: {
		type: 'object',
		properties: {
			maxBuckets: { type: 'integer' as const, nullable: true, description: 'Max buckets per user' },
			maxBucketSizeBytes: { type: 'integer' as const, nullable: true, description: 'Max bucket size in bytes' },
			maxFilesPerBucket: { type: 'integer' as const, nullable: true, description: 'Max files per bucket' },
			maxDailyUploads: { type: 'integer' as const, nullable: true, description: 'Max daily uploads' },
		},
		required: ['maxBuckets', 'maxBucketSizeBytes', 'maxFilesPerBucket', 'maxDailyUploads'],
	} as const,
	AppSettings: {
		type: 'array',
		items: {
			type: 'object',
			properties: {
				key: { type: 'string' as const, description: 'Setting key' },
				value: { type: 'string' as const, description: 'Setting value' },
			},
			required: ['key', 'value'],
		} as const,
	} as const,
} as const;

export type Packed<x extends keyof typeof refs> = SchemaType<typeof refs[x]>;

export type KeyOf<x extends keyof typeof refs> = PropertiesToUnion<typeof refs[x]>;
type PropertiesToUnion<p extends Schema> = p['properties'] extends NonNullable<Obj> ? keyof p['properties'] : never;

type TypeStringef = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object' | 'any';
type StringDefToType<T extends TypeStringef> =
	T extends 'null' ? null :
	T extends 'boolean' ? boolean :
	T extends 'integer' ? number :
	T extends 'number' ? number :
	T extends 'string' ? string | Date :
	T extends 'array' ? ReadonlyArray<any> :
	T extends 'object' ? Record<string, any> :
	any;

// https://swagger.io/specification/?sbsearch=optional#schema-object
type OfSchema = {
	readonly anyOf?: ReadonlyArray<Schema>;
	readonly oneOf?: ReadonlyArray<Schema>;
	readonly allOf?: ReadonlyArray<Schema>;
};

export interface Schema extends OfSchema {
	readonly type?: TypeStringef;
	readonly nullable?: boolean;
	readonly optional?: boolean;
	readonly prefixItems?: ReadonlyArray<Schema>;
	readonly items?: Schema;
	readonly unevaluatedItems?: Schema | boolean;
	readonly properties?: Obj;
	readonly required?: ReadonlyArray<Extract<keyof NonNullable<this['properties']>, string>>;
	readonly description?: string;
	readonly example?: any;
	readonly format?: string;
	readonly ref?: keyof typeof refs;
	readonly selfRef?: boolean;
	readonly enum?: ReadonlyArray<string | null>;
	readonly default?: (this['type'] extends TypeStringef ? StringDefToType<this['type']> : any) | null;
	readonly maxLength?: number;
	readonly minLength?: number;
	readonly maximum?: number;
	readonly minimum?: number;
	readonly pattern?: string;
	readonly additionalProperties?: Schema | boolean;
}

type RequiredPropertyNames<s extends Obj> = {
	[K in keyof s]:
	// K is not optional
	s[K]['optional'] extends false ? K :
	// K has default value
	s[K]['default'] extends null | string | number | boolean | Record<string, unknown> ? K :
	never
}[keyof s];

export type Obj = Record<string, Schema>;

// https://github.com/misskey-dev/misskey/issues/8535
// To avoid excessive stack depth error,
// deceive TypeScript with UnionToIntersection (or more precisely, `infer` expression within it).
export type ObjType<s extends Obj, RequiredProps extends ReadonlyArray<keyof s>> =
	UnionToIntersection<
		{ -readonly [R in RequiredPropertyNames<s>]-?: SchemaType<s[R]> } &
		{ -readonly [R in RequiredProps[number]]-?: SchemaType<s[R]> } &
		{ -readonly [P in keyof s]?: SchemaType<s[P]> }
	>;

type NullOrUndefined<p extends Schema, T> =
	| (p['nullable'] extends true ? null : never)
	| (p['optional'] extends true ? undefined : never)
	| T;

// https://stackoverflow.com/questions/54938141/typescript-convert-union-to-intersection
// Get intersection from union
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type ArrayToIntersection<T extends ReadonlyArray<Schema>> =
	T extends readonly [infer Head, ...infer Tail]
		? Head extends Schema
			? Tail extends ReadonlyArray<Schema>
				? Tail extends []
					? SchemaType<Head>
					: SchemaType<Head> & ArrayToIntersection<Tail>
				: never
			: never
		: never;

// https://github.com/misskey-dev/misskey/pull/8144#discussion_r785287552
// To get union, we use `Foo extends any ? Hoge<Foo> : never`
type UnionSchemaType<a extends readonly any[], X extends Schema = a[number]> = X extends any ? SchemaType<X> : never;
//type UnionObjectSchemaType<a extends readonly any[], X extends Schema = a[number]> = X extends any ? ObjectSchemaType<X> : never;
type UnionObjType<s extends Obj, a extends readonly any[], X extends ReadonlyArray<keyof s> = a[number]> = X extends any ? ObjType<s, X> : never;
type ArrayUnion<T> = T extends any ? Array<T> : never;
type ArrayToTuple<X extends ReadonlyArray<Schema>> = { [K in keyof X]: SchemaType<X[K]> };

type ObjectSchemaTypeDef<p extends Schema> =
	p['ref'] extends keyof typeof refs ? Packed<p['ref']> :
	p['properties'] extends NonNullable<Obj> ?
		p['anyOf'] extends ReadonlyArray<Schema> ? p['anyOf'][number]['required'] extends ReadonlyArray<keyof p['properties']> ?
			UnionObjType<p['properties'], NonNullable<p['anyOf'][number]['required']>> & ObjType<p['properties'], NonNullable<p['required']>>
			: never
		: ObjType<p['properties'], NonNullable<p['required']>>
		:
		p['anyOf'] extends ReadonlyArray<Schema> ? UnionSchemaType<p['anyOf']> :
		p['allOf'] extends ReadonlyArray<Schema> ? ArrayToIntersection<p['allOf']> :
		p['additionalProperties'] extends true ? Record<string, any> :
		p['additionalProperties'] extends Schema ?
			p['additionalProperties'] extends infer AdditionalProperties ?
				AdditionalProperties extends Schema ?
					Record<string, SchemaType<AdditionalProperties>> :
					never :
				never :
			any;

export type SchemaTypeDef<p extends Schema> =
	p['type'] extends 'null' ? null :
	p['type'] extends 'integer' ? number :
	p['type'] extends 'number' ? number :
	p['type'] extends 'string' ? (
		p['enum'] extends readonly (string | null)[] ?
			p['enum'][number] :
			p['format'] extends 'date-time' ? string : // Dateにする？？
			string
	) :
		p['type'] extends 'boolean' ? boolean :
		p['type'] extends 'object' ? ObjectSchemaTypeDef<p> :
		p['type'] extends 'array' ? (
			p['items'] extends OfSchema ? (
				p['items']['anyOf'] extends ReadonlyArray<Schema> ? UnionSchemaType<NonNullable<p['items']['anyOf']>>[] :
				p['items']['oneOf'] extends ReadonlyArray<Schema> ? ArrayUnion<UnionSchemaType<NonNullable<p['items']['oneOf']>>> :
				p['items']['allOf'] extends ReadonlyArray<Schema> ? UnionToIntersection<UnionSchemaType<NonNullable<p['items']['allOf']>>>[] :
				never
			) :
				p['prefixItems'] extends ReadonlyArray<Schema> ? (
					p['items'] extends NonNullable<Schema> ? [...ArrayToTuple<p['prefixItems']>, ...SchemaType<p['items']>[]] :
					p['items'] extends false ? ArrayToTuple<p['prefixItems']> :
					p['unevaluatedItems'] extends false ? ArrayToTuple<p['prefixItems']> :
					[...ArrayToTuple<p['prefixItems']>, ...unknown[]]
				) :
					p['items'] extends NonNullable<Schema> ? SchemaType<p['items']>[] :
					any[]
		) :
			p['anyOf'] extends ReadonlyArray<Schema> ? UnionSchemaType<p['anyOf']> :
			p['allOf'] extends ReadonlyArray<Schema> ? ArrayToIntersection<p['allOf']> :
			p['oneOf'] extends ReadonlyArray<Schema> ? UnionSchemaType<p['oneOf']> :
			any;

export type SchemaType<p extends Schema> = NullOrUndefined<p, SchemaTypeDef<p>>;

// API Schema extraction utilities
type FindEndpoint<T extends readonly any[], Path extends string, Method extends string> =
	T extends readonly [infer First, ...infer Rest]
		? First extends { path: infer P; method: infer M; requestBody?: any }
			? P extends Path
				? M extends Method
					? First
					: FindEndpoint<Rest, Path, Method>
				: FindEndpoint<Rest, Path, Method>
			: FindEndpoint<Rest, Path, Method>
		: never;

export type ExtractRequestSchema<
	T extends readonly any[],
	Path extends string,
	Method extends string,
> = FindEndpoint<T, Path, Method> extends { requestBody?: infer RB }
	? RB extends { 'application/json': infer S }
		? S
		: never
	: never;

type FindEndpointForResponse<T extends readonly any[], Path extends string, Method extends string> =
	T extends readonly [infer First, ...infer Rest]
		? First extends { path: infer P; method: infer M; responses?: any }
			? P extends Path
				? M extends Method
					? First
					: FindEndpointForResponse<Rest, Path, Method>
				: FindEndpointForResponse<Rest, Path, Method>
			: FindEndpointForResponse<Rest, Path, Method>
		: never;

export type ExtractResponseSchema<
	T extends readonly any[],
	Path extends string,
	Method extends string,
	Status extends string | number = 200,
> = FindEndpointForResponse<T, Path, Method> extends { responses?: infer Responses }
	? Responses extends Record<string | number, any>
		? keyof Responses & (Status | string) extends infer K extends keyof Responses
			? Responses[K] extends { content: { 'application/json': { schema: infer S } } }
				? S extends Schema
					? S
					: never
				: Responses[K] extends { schema: infer S }
					? S extends Schema
						? S
						: never
					: never
			: never
		: never
	: never;

// Direct type extraction utilities - returns SchemaType directly
export type ExtractRequestType<
	T extends readonly any[],
	Path extends string,
	Method extends string,
> = SchemaType<ExtractRequestSchema<T, Path, Method> extends infer S extends Schema ? S : never>;

export type ExtractResponseType<
	T extends readonly any[],
	Path extends string,
	Method extends string,
	Status extends string | number = 200,
> = SchemaType<ExtractResponseSchema<T, Path, Method, Status>>;
