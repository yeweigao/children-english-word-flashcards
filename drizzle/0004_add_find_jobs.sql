CREATE TABLE `find_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`level` text DEFAULT 'movers' NOT NULL,
	`photo_keys_json` text DEFAULT '[]' NOT NULL,
	`analysis_json` text,
	`result_json` text,
	`error` text,
	`photos_deleted` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `find_job_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`idx` integer NOT NULL,
	`mime_type` text NOT NULL,
	`image_base64` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `find_job_pages_job_idx` ON `find_job_pages` (`job_id`);
