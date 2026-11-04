CREATE TABLE `demo_ai_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`quota_day` text DEFAULT '' NOT NULL,
	`admissions` integer DEFAULT 0 NOT NULL,
	`token_hash` text,
	`state` text DEFAULT 'idle' NOT NULL,
	`call_id` text,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`close_requested` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL
);
