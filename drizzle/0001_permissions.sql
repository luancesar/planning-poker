ALTER TABLE "participants" ADD COLUMN "can_reveal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "vote_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing rooms: drop auto-reveal, keep them open (no approval) and give facilitators every permission.
UPDATE "rooms" SET "settings" = ("settings" - 'autoReveal') || '{"requireApproval": false, "permissions": {"reveal": "facilitators", "rounds": "facilitators", "items": "facilitators"}}'::jsonb;
