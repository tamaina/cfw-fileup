import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ユーザー名の再利用防止テーブル（lowercaseで保存）
// 削除されたユーザーのユーザー名も再登録できないようにする
export const usedUsernames = sqliteTable('used_usernames', {
	username: text('username').primaryKey(),
});

// バケット名の再利用防止テーブル（lowercaseで保存）
// 削除されたバケットの名前も再登録できないようにする
export const usedBucketNames = sqliteTable('used_bucket_names', {
	bucketName: text('bucket_name').primaryKey(),
});
