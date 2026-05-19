import { eq } from 'drizzle-orm';
import { appSettings, usedUsernames, usedBucketNames } from '../scheme/index';
import { DEFAULT_FORBIDDEN_USERNAMES, DEFAULT_FORBIDDEN_BUCKET_NAMES } from '../../shared/app-settings';
import { isValidNameFormat } from '../../shared/name-validation';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

export { isValidNameFormat };

/**
 * 設定テーブルから禁止名リストを取得する
 * 設定が存在しない場合はデフォルト値を返す
 */
async function getForbiddenNames(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	db: DrizzleD1Database<any>,
	settingKey: string,
	defaultValue: string,
): Promise<Set<string>> {
	const setting = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, settingKey))
		.get();

	const value = setting?.value ?? defaultValue;
	// カンマ区切りのリストを小文字のSetに変換
	return new Set(
		value
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter((name) => name.length > 0),
	);
}

/**
 * ユーザー名が使用可能かバリデーションする
 * @returns エラーメッセージ（問題なければnull）
 */
export async function validateUsername(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	db: DrizzleD1Database<any>,
	username: string,
): Promise<string | null> {
	// 文字種チェック
	if (!isValidNameFormat(username)) {
		return 'username can only contain alphanumeric characters and underscores [0-9a-zA-Z_]';
	}

	const usernameLower = username.toLowerCase();

	// 禁止ワードチェック
	const forbidden = await getForbiddenNames(db, 'forbidden_usernames', DEFAULT_FORBIDDEN_USERNAMES);
	if (forbidden.has(usernameLower)) {
		return 'This username is not allowed';
	}

	// 大文字小文字を区別しない重複チェック（used_usernamesテーブル）
	const usedEntry = await db
		.select()
		.from(usedUsernames)
		.where(eq(usedUsernames.username, usernameLower))
		.get();
	if (usedEntry) {
		return 'Username already exists';
	}

	return null;
}

/**
 * バケット名が使用可能かバリデーションする
 * @returns エラーメッセージ（問題なければnull）
 */
export async function validateBucketName(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	db: DrizzleD1Database<any>,
	bucketName: string,
): Promise<string | null> {
	// 文字種チェック
	if (!isValidNameFormat(bucketName)) {
		return 'Bucket name can only contain alphanumeric characters and underscores [0-9a-zA-Z_]';
	}

	const bucketNameLower = bucketName.toLowerCase();

	// 禁止ワードチェック
	const forbidden = await getForbiddenNames(db, 'forbidden_bucket_names', DEFAULT_FORBIDDEN_BUCKET_NAMES);
	if (forbidden.has(bucketNameLower)) {
		return 'This bucket name is not allowed';
	}

	// 大文字小文字を区別しない重複チェック（used_bucket_namesテーブル）
	const usedEntry = await db
		.select()
		.from(usedBucketNames)
		.where(eq(usedBucketNames.bucketName, bucketNameLower))
		.get();
	if (usedEntry) {
		return 'Bucket name already exists';
	}

	return null;
}
