ALTER TABLE `files` ADD `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE;
