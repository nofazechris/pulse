ALTER TABLE "trade_plans" ADD COLUMN "sell_fraction" numeric;--> statement-breakpoint
ALTER TABLE "trade_plans" ADD COLUMN "hit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_plans" ADD COLUMN "hit_price" numeric;