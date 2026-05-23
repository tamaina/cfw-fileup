ALTER TABLE `oauth_states` ADD `link_user_id` text REFERENCES `users`(`id`) ON DELETE cascade;
