import * as v from 'valibot';

/** 禁止ユーザー名のデフォルト値（カンマ区切り） */
export const DEFAULT_FORBIDDEN_USERNAMES =
	'admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,cloudflare,cf';

/** 禁止バケット名のデフォルト値（カンマ区切り） */
export const DEFAULT_FORBIDDEN_BUCKET_NAMES =
	'admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,cloudflare,cf';

export const registrationModeSchema = v.picklist(['closed', 'passphrase', 'open']);
export type RegistrationMode = v.InferOutput<typeof registrationModeSchema>;

/**
 * app_settings テーブルで管理する設定項目。
 * キーが設定キー、値が valibot スキーマ（v.optional でデフォルト値も内包）。
 */
export const KNOWN_SETTINGS = {
	registration_mode: v.optional(registrationModeSchema, 'passphrase' satisfies RegistrationMode),
	forbidden_usernames: v.optional(v.string(), DEFAULT_FORBIDDEN_USERNAMES),
	forbidden_bucket_names: v.optional(v.string(), DEFAULT_FORBIDDEN_BUCKET_NAMES),
} as const;

export type KnownSettingKey = keyof typeof KNOWN_SETTINGS;
export const KNOWN_SETTING_KEYS = Object.keys(KNOWN_SETTINGS) as KnownSettingKey[];
