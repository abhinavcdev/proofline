CREATE TABLE "challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"rung" text NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sends" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"account_ref" text,
	"contact_email" text,
	"secret" jsonb,
	"tried" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "end_user_passkeys" (
	"project_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"account_ref" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "end_user_passkeys_project_id_credential_id_pk" PRIMARY KEY("project_id","credential_id")
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"challenge_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "challenges_project_decision_idx" ON "challenges" USING btree ("project_id","decision_id");--> statement-breakpoint
CREATE INDEX "end_user_passkeys_account_idx" ON "end_user_passkeys" USING btree ("project_id","account_ref");--> statement-breakpoint
CREATE INDEX "review_items_project_state_idx" ON "review_items" USING btree ("project_id","state","created_at");