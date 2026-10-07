CREATE TABLE "telegram_agent_work" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"update_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"inbound_message_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp,
	"completed_at" timestamp,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"bot_username" text,
	"token_cipher" text,
	"token_iv" text,
	"token_tag" text,
	"allowed_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"last_error_code" text,
	"next_update_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"origin" text NOT NULL,
	"trigger_message_id" text,
	"message_id" text,
	"telegram_message_id" text,
	"status" text DEFAULT 'reserved' NOT NULL,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_update" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"update_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"disposition" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_agent_work" ADD CONSTRAINT "telegram_agent_work_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_agent_work" ADD CONSTRAINT "telegram_agent_work_credential_id_telegram_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."telegram_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_agent_work" ADD CONSTRAINT "telegram_agent_work_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_agent_work" ADD CONSTRAINT "telegram_agent_work_inbound_message_id_message_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_credentials" ADD CONSTRAINT "telegram_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_delivery" ADD CONSTRAINT "telegram_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_delivery" ADD CONSTRAINT "telegram_delivery_credential_id_telegram_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."telegram_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_delivery" ADD CONSTRAINT "telegram_delivery_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_delivery" ADD CONSTRAINT "telegram_delivery_trigger_message_id_message_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_delivery" ADD CONSTRAINT "telegram_delivery_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_update" ADD CONSTRAINT "telegram_update_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_update" ADD CONSTRAINT "telegram_update_credential_id_telegram_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."telegram_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_update" ADD CONSTRAINT "telegram_update_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_update" ADD CONSTRAINT "telegram_update_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_agent_work_update_uq" ON "telegram_agent_work" USING btree ("credential_id","update_id");--> statement-breakpoint
CREATE INDEX "telegram_agent_work_org_status_idx" ON "telegram_agent_work" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_credentials_org_uq" ON "telegram_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_credentials_bot_uq" ON "telegram_credentials" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "telegram_credentials_connected_idx" ON "telegram_credentials" USING btree ("connected","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_delivery_org_key_uq" ON "telegram_delivery" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_delivery_message_uq" ON "telegram_delivery" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "telegram_delivery_org_status_idx" ON "telegram_delivery" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_update_credential_update_uq" ON "telegram_update" USING btree ("credential_id","update_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_update_provider_message_uq" ON "telegram_update" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "telegram_update_org_created_idx" ON "telegram_update" USING btree ("organization_id","created_at");