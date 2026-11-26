import type {
  AudioStartConfig,
  Modality,
  OrchestratedSessionStatus,
  ProviderName,
  QualityTier,
  VideoStartConfig,
} from "@metamorph/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema.ts";

/** Persisted Ed25519 signing key for engine-py JWTs (private key encrypted at rest). */
export const engineSigningKey = pgTable("engine_signing_key", {
  id: text("id").primaryKey(),
  publicKeyPem: text("public_key_pem").notNull(),
  publicKeyJwk: jsonb("public_key_jwk").$type<Record<string, unknown>>().notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Uploaded reference images and voice clips stored in S3 or local ObjectStorage. */
export const mediaAsset = pgTable(
  "media_asset",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"ref_image" | "ref_audio">().notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("media_asset_user_kind_idx").on(table.userId, table.kind)],
);

/** Reusable character/voice/video presets for launching or hot-swapping sessions. */
export const persona = pgTable(
  "persona",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    modalities: jsonb("modalities").$type<ReadonlyArray<Modality>>().notNull(),
    prompt: text("prompt"),
    refImageAssetId: text("ref_image_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    refAudioAssetId: text("ref_audio_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    videoConfig: jsonb("video_config").$type<VideoStartConfig | null>(),
    audioConfig: jsonb("audio_config").$type<AudioStartConfig | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("persona_user_id_idx").on(table.userId)],
);

/** Dedicated single-user GPU inference sessions managed by `@metamorph/orchestrator`. */
export const engineSession = pgTable(
  "engine_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    personaId: text("persona_id").references(() => persona.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<OrchestratedSessionStatus>().notNull(),
    modalities: jsonb("modalities").$type<ReadonlyArray<Modality>>().notNull(),
    quality: text("quality").$type<QualityTier>().notNull(),
    provider: text("provider").$type<ProviderName>().notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    gpuType: text("gpu_type").notNull(),
    image: text("image").notNull(),
    httpUrl: text("http_url"),
    wsUrl: text("ws_url"),
    tlsSupported: boolean("tls_supported").default(true).notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    hourlyRateUsd: doublePrecision("hourly_rate_usd"),
    idleTimeoutS: integer("idle_timeout_s").notNull(),
    disconnectTimeoutS: integer("disconnect_timeout_s").notNull(),
    maxDurationS: integer("max_duration_s").notNull(),
    initialPrompt: text("initial_prompt"),
    refImageAssetId: text("ref_image_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    refAudioAssetId: text("ref_audio_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    failureReason: text("failure_reason"),
    readyAt: timestamp("ready_at"),
    connectedAt: timestamp("connected_at"),
    disconnectedAt: timestamp("disconnected_at"),
    endedAt: timestamp("ended_at"),
    activeSeconds: integer("active_seconds").default(0).notNull(),
    estimatedCostUsd: doublePrecision("estimated_cost_usd").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("engine_session_user_status_idx").on(table.userId, table.status),
    index("engine_session_status_idx").on(table.status),
    index("engine_session_created_at_idx").on(table.createdAt),
    uniqueIndex("engine_session_one_active_per_user")
      .on(table.userId)
      .where(sql`${table.status} NOT IN ('stopped', 'failed')`),
  ],
);
