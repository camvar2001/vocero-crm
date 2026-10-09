CREATE TABLE "inmob_web_chat" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inmob_web_chat_agent_check" CHECK ("agent" in ('secretaria','buscador'))
);
--> statement-breakpoint
CREATE TABLE "inmob_web_turn" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"message" text NOT NULL,
	"reply" text,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inmob_web_turn_status_check" CHECK ("status" in ('running','completed','failed','uncertain'))
);
--> statement-breakpoint
CREATE TABLE "inmob_tool_action" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"name" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "inmob_tool_action_status_check" CHECK ("status" in ('running','completed','failed','uncertain'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inmob_web_chat_id_org_user_uq" ON "inmob_web_chat" USING btree ("id","organization_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inmob_web_turn_id_org_user_uq" ON "inmob_web_turn" USING btree ("id","organization_id","user_id");
--> statement-breakpoint
ALTER TABLE "inmob_web_chat" ADD CONSTRAINT "inmob_web_chat_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_web_chat" ADD CONSTRAINT "inmob_web_chat_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_web_turn" ADD CONSTRAINT "inmob_web_turn_chat_org_user_fk" FOREIGN KEY ("chat_id", "organization_id", "user_id") REFERENCES "public"."inmob_web_chat"("id", "organization_id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_web_turn" ADD CONSTRAINT "inmob_web_turn_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_web_turn" ADD CONSTRAINT "inmob_web_turn_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_tool_action" ADD CONSTRAINT "inmob_tool_action_turn_org_user_fk" FOREIGN KEY ("turn_id", "organization_id", "user_id") REFERENCES "public"."inmob_web_turn"("id", "organization_id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_tool_action" ADD CONSTRAINT "inmob_tool_action_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inmob_tool_action" ADD CONSTRAINT "inmob_tool_action_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "inmob_web_chat_org_user_agent_uq" ON "inmob_web_chat" USING btree ("organization_id","user_id","agent");
--> statement-breakpoint
CREATE INDEX "inmob_web_chat_org_user_idx" ON "inmob_web_chat" USING btree ("organization_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inmob_web_turn_org_user_request_uq" ON "inmob_web_turn" USING btree ("organization_id","user_id","request_id");
--> statement-breakpoint
CREATE INDEX "inmob_web_turn_org_user_created_idx" ON "inmob_web_turn" USING btree ("organization_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX "inmob_web_turn_chat_created_idx" ON "inmob_web_turn" USING btree ("chat_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "inmob_web_turn_chat_running_uq" ON "inmob_web_turn" USING btree ("chat_id") WHERE "status" = 'running';
--> statement-breakpoint
CREATE UNIQUE INDEX "inmob_tool_action_turn_call_uq" ON "inmob_tool_action" USING btree ("turn_id","tool_call_id");
--> statement-breakpoint
CREATE INDEX "inmob_tool_action_org_turn_idx" ON "inmob_tool_action" USING btree ("organization_id","turn_id");
