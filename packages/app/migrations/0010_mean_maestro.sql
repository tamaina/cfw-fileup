-- https://github.com/tamaina/cfw-fileup/pull/108
ALTER TABLE `file_reports` ADD `reporter_user_id` text REFERENCES users(id);
