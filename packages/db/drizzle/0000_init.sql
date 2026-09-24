CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "decision_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"project_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text NOT NULL,
	"effective_action" text NOT NULL,
	"mode" text NOT NULL,
	"rung" text,
	"risk" integer NOT NULL,
	"matched" text NOT NULL,
	"decision_source" text NOT NULL,
	"fallback_reason" text,
	"questions_version" text NOT NULL,
	"policy_version" integer NOT NULL,
	"token_status" text NOT NULL,
	"p_automated" real,
	"actor_type" text,
	"actor_conf" real,
	"risk_level" integer,
	"risk_conf" real,
	"intent" text,
	"p_templated" real,
	"answers" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"ip_hash" text,
	"asn" integer,
	"country" text,
	"ja4" text,
	"ua_family" text,
	"declared_agent" text,
	"t_total_ms" real NOT NULL,
	"t_verify_ms" real,
	"t_edge_ms" real,
	"t_state_ms" real,
	"t_decide_ms" real,
	"t_policy_ms" real
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"label" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"project_id" text NOT NULL,
	"event_type" text NOT NULL,
	"version" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_project_id_event_type_version_pk" PRIMARY KEY("project_id","event_type","version")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"questions_version" text DEFAULT 'v1' NOT NULL,
	"jev_timeout_ms" integer DEFAULT 400 NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pow_bits" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"project_id" text NOT NULL,
	"day" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text NOT NULL,
	"shadow" boolean NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "usage_daily_project_id_day_event_type_action_shadow_pk" PRIMARY KEY("project_id","day","event_type","action","shadow")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "decision_events_project_ts_idx" ON "decision_events" USING btree ("project_id","ts");--> statement-breakpoint
CREATE INDEX "decision_events_project_event_ts_idx" ON "decision_events" USING btree ("project_id","event_type","ts");--> statement-breakpoint
CREATE INDEX "decision_events_project_action_ts_idx" ON "decision_events" USING btree ("project_id","action","ts");--> statement-breakpoint
CREATE INDEX "feedback_project_decision_idx" ON "feedback" USING btree ("project_id","decision_id");