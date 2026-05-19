-- マルチパートアップロードのパートサイズをクライアントが宣言できるようにする
-- R2のClass A操作コスト削減のため、デフォルトを32MiBに設定
ALTER TABLE `files` ADD `part_size` integer NOT NULL DEFAULT 33554432;
