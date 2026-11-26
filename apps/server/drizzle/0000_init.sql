CREATE TABLE "kb_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"heading_path" text[] NOT NULL,
	"heading_text" text NOT NULL,
	"content" text NOT NULL,
	"embedding_input" text NOT NULL,
	"tiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', heading_text || ' ' || content)) STORED
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"tiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_hash" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"client_turn_id" text,
	"role" text NOT NULL,
	"mode" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"tool_name" text,
	"visible" boolean DEFAULT true NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_id_unique" UNIQUE("id"),
	CONSTRAINT "messages_client_turn" UNIQUE("session_id","client_turn_id"),
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "refunds_session_invoice" UNIQUE("session_id","invoice_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"customer_id" text,
	"verified_at" timestamp with time zone,
	"failed_verifications" integer DEFAULT 0 NOT NULL,
	"escalation" jsonb,
	"chaos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"account_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"customer_id" text,
	"priority" text NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"queue" text NOT NULL,
	"summary" text NOT NULL,
	"sla_hours" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"trace" jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_doc_id_kb_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_chunks_embedding_hnsw" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "kb_chunks_tsv_gin" ON "kb_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "kb_chunks_doc" ON "kb_chunks" USING btree ("doc_id","ordinal");--> statement-breakpoint
CREATE INDEX "kb_chunks_hash" ON "kb_chunks" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "messages_session_seq" ON "messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "traces_session" ON "traces" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_created" ON "usage_events" USING btree ("created_at");