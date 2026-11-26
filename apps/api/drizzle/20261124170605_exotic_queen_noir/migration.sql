CREATE TABLE "engine_session" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"persona_id" text,
	"status" text NOT NULL,
	"modalities" jsonb NOT NULL,
	"quality" text NOT NULL,
	"provider" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"gpu_type" text NOT NULL,
	"image" text NOT NULL,
	"http_url" text,
	"ws_url" text,
	"tls_supported" boolean DEFAULT true NOT NULL,
	"webhook_secret" text NOT NULL,
	"hourly_rate_usd" double precision,
	"idle_timeout_s" integer NOT NULL,
	"disconnect_timeout_s" integer NOT NULL,
	"max_duration_s" integer NOT NULL,
	"initial_prompt" text,
	"ref_image_asset_id" text,
	"ref_audio_asset_id" text,
	"failure_reason" text,
	"ready_at" timestamp,
	"connected_at" timestamp,
	"disconnected_at" timestamp,
	"ended_at" timestamp,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engine_signing_key" (
	"id" text PRIMARY KEY,
	"public_key_pem" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_asset" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL UNIQUE,
	"sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"modalities" jsonb NOT NULL,
	"prompt" text,
	"ref_image_asset_id" text,
	"ref_audio_asset_id" text,
	"video_config" jsonb,
	"audio_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_session_user_status_idx" ON "engine_session" ("user_id","status");--> statement-breakpoint
CREATE INDEX "engine_session_status_idx" ON "engine_session" ("status");--> statement-breakpoint
CREATE INDEX "engine_session_created_at_idx" ON "engine_session" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "engine_session_one_active_per_user" ON "engine_session" ("user_id") WHERE "status" NOT IN ('stopped', 'failed');--> statement-breakpoint
CREATE INDEX "media_asset_user_kind_idx" ON "media_asset" ("user_id","kind");--> statement-breakpoint
CREATE INDEX "persona_user_id_idx" ON "persona" ("user_id");--> statement-breakpoint
ALTER TABLE "engine_session" ADD CONSTRAINT "engine_session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "engine_session" ADD CONSTRAINT "engine_session_persona_id_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "persona"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "engine_session" ADD CONSTRAINT "engine_session_ref_image_asset_id_media_asset_id_fkey" FOREIGN KEY ("ref_image_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "engine_session" ADD CONSTRAINT "engine_session_ref_audio_asset_id_media_asset_id_fkey" FOREIGN KEY ("ref_audio_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_ref_image_asset_id_media_asset_id_fkey" FOREIGN KEY ("ref_image_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_ref_audio_asset_id_media_asset_id_fkey" FOREIGN KEY ("ref_audio_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL;