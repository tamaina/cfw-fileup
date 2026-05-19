-- ユーザー名・バケット名の再利用防止テーブル
-- 削除されても同じ名前（lowercase）を再登録できないようにする
CREATE TABLE `used_usernames` (
	`username` text PRIMARY KEY NOT NULL
);

CREATE TABLE `used_bucket_names` (
	`bucket_name` text PRIMARY KEY NOT NULL
);
