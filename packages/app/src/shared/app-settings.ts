export interface SettingDef {
	readonly key: string;
	readonly type: 'boolean' | 'text';
	readonly defaultValue: string;
	readonly label: string;
	readonly description?: string;
}

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
] as const satisfies readonly SettingDef[];

export type KnownSettingKey = (typeof KNOWN_SETTINGS)[number]['key'];

export const KNOWN_SETTING_KEYS: readonly string[] = KNOWN_SETTINGS.map((s) => s.key);
