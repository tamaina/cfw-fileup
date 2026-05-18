export interface SettingDef {
	readonly key: string;
	readonly type: 'boolean' | 'text';
	readonly defaultValue: string;
	readonly label: string;
	readonly description?: string;
}

/** 禁止ユーザー名のデフォルト値（カンマ区切り） */
export const DEFAULT_FORBIDDEN_USERNAMES =
	'admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,cloudflare,cf';

/** 禁止バケット名のデフォルト値（カンマ区切り） */
export const DEFAULT_FORBIDDEN_BUCKET_NAMES =
	'admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,cloudflare,cf';

export const KNOWN_SETTINGS = [
	{
		key: 'registration_enabled',
		type: 'boolean',
		defaultValue: 'true',
		label: '新規登録を許可',
	},
	{
		key: 'require_signup_passphrase',
		type: 'boolean',
		defaultValue: 'false',
		label: 'サインアップパスフレーズを要求',
		description: '有効にすると登録時に環境変数 SIGNUP_PASSPHRASE の値が必要になります',
	},
	{
		key: 'forbidden_usernames',
		type: 'text',
		defaultValue: DEFAULT_FORBIDDEN_USERNAMES,
		label: '禁止ユーザー名',
		description: 'カンマ区切りで禁止するユーザー名を指定します（大文字小文字を区別しない）',
	},
	{
		key: 'forbidden_bucket_names',
		type: 'text',
		defaultValue: DEFAULT_FORBIDDEN_BUCKET_NAMES,
		label: '禁止バケット名',
		description: 'カンマ区切りで禁止するバケット名を指定します（大文字小文字を区別しない）',
	},
] as const satisfies readonly SettingDef[];

export type KnownSettingKey = (typeof KNOWN_SETTINGS)[number]['key'];

export const KNOWN_SETTING_KEYS: readonly string[] = KNOWN_SETTINGS.map((s) => s.key);
