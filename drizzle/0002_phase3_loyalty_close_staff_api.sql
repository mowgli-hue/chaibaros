CREATE TABLE "cash_drawer_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"day" text NOT NULL,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float_cents" integer DEFAULT 0 NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"counted_cents" integer,
	"paid_out_cents" integer DEFAULT 0 NOT NULL,
	"paid_out_note" text,
	"expected_cents" integer,
	"variance_cents" integer,
	"deposit_cents" integer,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "daily_closes" (
	"location_id" text NOT NULL,
	"day" text NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"pst_cents" integer DEFAULT 0 NOT NULL,
	"tips_cents" integer DEFAULT 0 NOT NULL,
	"fees_cents" integer DEFAULT 0 NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"refunds_cents" integer DEFAULT 0 NOT NULL,
	"by_tender" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_channel" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cash_expected_cents" integer DEFAULT 0 NOT NULL,
	"cash_counted_cents" integer DEFAULT 0 NOT NULL,
	"cash_variance_cents" integer DEFAULT 0 NOT NULL,
	"tip_allocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labour_cents" integer DEFAULT 0 NOT NULL,
	"labour_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"note" text,
	"exported_at" timestamp with time zone,
	CONSTRAINT "daily_closes_location_id_day_pk" PRIMARY KEY("location_id","day")
);
--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"lifetime_earned" integer DEFAULT 0 NOT NULL,
	"lifetime_redeemed" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'member' NOT NULL,
	"birthday" text,
	"last_birthday_bonus_year" integer,
	"referral_code" text,
	"referred_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_accounts_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"order_id" text,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"note" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"brand_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Chai Club' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"points_per_dollar" integer DEFAULT 10 NOT NULL,
	"redeem_cents_per_point" integer DEFAULT 1 NOT NULL,
	"min_redeem_points" integer DEFAULT 500 NOT NULL,
	"max_redeem_pct_of_order" integer DEFAULT 50 NOT NULL,
	"signup_bonus_points" integer DEFAULT 100 NOT NULL,
	"birthday_bonus_points" integer DEFAULT 300 NOT NULL,
	"earn_on_channels" jsonb DEFAULT '["counter","clover","app_thru","vlink","tiffingo"]'::jsonb NOT NULL,
	"points_expire_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"promotion_id" text NOT NULL,
	"order_id" text,
	"customer_id" text,
	"discount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'percent' NOT NULL,
	"value" integer DEFAULT 10 NOT NULL,
	"free_item_sku" text,
	"min_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_order_only" boolean DEFAULT false NOT NULL,
	"once_per_customer" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"max_redemptions" integer,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"device" text,
	"api_client_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_tokens" ADD CONSTRAINT "staff_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_tokens" ADD CONSTRAINT "staff_tokens_api_client_id_api_clients_id_fk" FOREIGN KEY ("api_client_id") REFERENCES "public"."api_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_drawer_location_day_idx" ON "cash_drawer_sessions" USING btree ("location_id","day");--> statement-breakpoint
CREATE INDEX "loyalty_accounts_brand_idx" ON "loyalty_accounts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "loyalty_ledger_customer_idx" ON "loyalty_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_ledger_order_kind" ON "loyalty_ledger" USING btree ("order_id","kind");--> statement-breakpoint
CREATE INDEX "promo_redemptions_promo_idx" ON "promo_redemptions" USING btree ("promotion_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_customer_idx" ON "promo_redemptions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_brand_code" ON "promotions" USING btree ("brand_id","code");--> statement-breakpoint
CREATE INDEX "staff_tokens_user_idx" ON "staff_tokens" USING btree ("user_id");