import * as v from 'valibot';

const VALID_NAME_PATTERN = /^[0-9a-zA-Z_]+$/;

export const NAME_FORMAT_ERROR = '英数字とアンダースコア [0-9a-zA-Z_] のみ使用できます';

/** 名前が使用可能な文字のみで構成されているか確認 */
export function isValidNameFormat(name: string): boolean {
	return VALID_NAME_PATTERN.test(name);
}

/** ユーザー名/バケット名のフォーマット検証 valibot アクション */
export const nameFormatValidation = v.regex(VALID_NAME_PATTERN, NAME_FORMAT_ERROR);
