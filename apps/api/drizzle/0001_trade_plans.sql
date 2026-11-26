CREATE TABLE "trade_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"trigger_price" numeric NOT NULL,
	"reference_price" numeric NOT NULL,
	"side" text,
	"quote_order_qty" numeric,
	"quantity" numeric,
	"status" text DEFAULT 'ARMED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"triggered_at" timestamp with time zone,
	"observed_price" numeric
);
--> statement-breakpoint
ALTER TABLE "trade_plans" ADD CONSTRAINT "trade_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_plans_user_status_idx" ON "trade_plans" USING btree ("user_id","status");