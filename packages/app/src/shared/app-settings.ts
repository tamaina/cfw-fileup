import * as v from 'valibot';
import { MAX_APP_SETTING_TEXT_LENGTH } from './const.js';

/** 禁止ユーザー名のデフォルト値（カンマ区切り） */
export const DEFAULT_FORBIDDEN_USERNAMES =
	'admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,cloudflare,cf';

/** 禁止バケット名のデフォルト値（カンマ区切り） */
export const DEFAULT_FORBIDDEN_BUCKET_NAMES =
	'admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,cloudflare,cf';

export const registrationModeSchema = v.picklist(['closed', 'passphrase', 'open']);
export type RegistrationMode = v.InferOutput<typeof registrationModeSchema>;
export const optionalUrlSettingSchema = v.union([
	v.literal(''),
	v.pipe(v.string(), v.url(), v.maxLength(MAX_APP_SETTING_TEXT_LENGTH)),
]);
export const optionalDateSettingSchema = v.union([
	v.literal(''),
	v.pipe(v.string(), v.isoDate()),
]);

/**
 * app_settings テーブルで管理する設定項目。
 * キーが設定キー、値が valibot スキーマ（v.optional でデフォルト値も内包）。
 */
export const KNOWN_SETTINGS = {
	registration_mode: v.optional(registrationModeSchema, 'passphrase' satisfies RegistrationMode),
	google_required: v.optional(v.picklist(['true', 'false']), 'false'),
	terms_url: v.optional(optionalUrlSettingSchema, ''),
	terms_updated_at: v.optional(optionalDateSettingSchema, ''),
	indieauth_blocked_servers: v.optional(v.pipe(v.string(), v.maxLength(MAX_APP_SETTING_TEXT_LENGTH)), ''),
	reject_mismatched_file_type: v.optional(v.picklist(['true', 'false']), 'false'),
	crypto_payments_enabled: v.optional(v.picklist(['true', 'false']), 'false'),
	forbidden_usernames: v.optional(v.pipe(v.string(), v.maxLength(MAX_APP_SETTING_TEXT_LENGTH)), DEFAULT_FORBIDDEN_USERNAMES),
	forbidden_bucket_names: v.optional(v.pipe(v.string(), v.maxLength(MAX_APP_SETTING_TEXT_LENGTH)), DEFAULT_FORBIDDEN_BUCKET_NAMES),
} as const;

export type KnownSettingKey = keyof typeof KNOWN_SETTINGS;
export const KNOWN_SETTING_KEYS = Object.keys(KNOWN_SETTINGS) as KnownSettingKey[];
export const KnownSettingKeySchema = v.picklist(KNOWN_SETTING_KEYS);
export type KnownSettingRecord = {
	[K in KnownSettingKey]: {
		key: K;
		value: v.InferOutput<(typeof KNOWN_SETTINGS)[K]>;
	};
}[KnownSettingKey];

function isOptionalSettingSchema(
	schema: v.GenericSchema,
): schema is v.OptionalSchema<v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, unknown> {
	return (schema as { type?: string }).type === 'optional';
}

function unwrapSettingSchema<TSchema extends v.GenericSchema>(schema: TSchema) {
	return isOptionalSettingSchema(schema) ? v.unwrap(schema) : schema;
}

const knownSettingVariantOptions = Object.entries(KNOWN_SETTINGS).map(([key, schema]) => v.object({
	key: v.literal(key),
	value: unwrapSettingSchema(schema),
})) as unknown as v.VariantOptions<'key'>;

export const KnownSettingRecordSchema = v.variant('key', knownSettingVariantOptions) as v.GenericSchema<unknown, KnownSettingRecord>;
export const KnownSettingListSchema = v.array(KnownSettingRecordSchema);
