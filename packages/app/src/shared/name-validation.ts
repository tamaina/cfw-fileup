/** ユーザー名・バケット名に使える文字: 英数字とアンダースコアのみ */
const VALID_NAME_PATTERN = /^[0-9a-zA-Z_]+$/;

/** 名前が使用可能な文字のみで構成されているか確認 */
export function isValidNameFormat(name: string): boolean {
	return VALID_NAME_PATTERN.test(name);
}

/** ユーザー名/バケット名の文字種エラーメッセージ */
export const NAME_FORMAT_ERROR = '英数字とアンダースコア [0-9a-zA-Z_] のみ使用できます';
