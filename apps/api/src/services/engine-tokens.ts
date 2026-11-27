import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import type { Modality } from "@metamorph/shared";
import { Modality as ModalitySchema } from "@metamorph/shared";
import { eq } from "drizzle-orm";
import { Clock, Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SecureRandom, Signature } from "effect/crypto";
import { Jwk, Jwt } from "effect/jose";

import { engineSigningKey } from "../db/schema.ts";
import { Database } from "./db.ts";

class EngineTokenError extends Schema.TaggedError<
  EngineTokenError,
  { readonly brand: unique symbol }
>()("EngineTokenError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const EngineJwtClaims = Schema.Struct({
  sub: Schema.String,
  aud: Schema.String,
  iss: Schema.optionalKey(Schema.String),
  exp: Schema.Int,
  iat: Schema.Int,
  jti: Schema.String,
  modalities: Schema.Array(ModalitySchema),
});
type EngineJwtClaims = typeof EngineJwtClaims.Type;

interface MintSessionTokenInput {
  readonly userId: string;
  readonly instanceId: string;
  readonly modalities: ReadonlyArray<Modality>;
  readonly ttlSeconds?: number | undefined;
}

interface MintedEngineToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly instanceId: string;
  readonly modalities: ReadonlyArray<Modality>;
}

interface EngineTokenServiceShape {
  readonly kid: string;
  readonly issuer: string;
  readonly publicKeyPem: string;
  readonly publicJwks: { readonly keys: ReadonlyArray<Jwk.PublicJwk> };
  readonly mintSessionToken: (
    input: MintSessionTokenInput,
  ) => Effect.Effect<MintedEngineToken, EngineTokenError>;
  readonly verifySessionToken: (
    token: string,
    expectedInstanceId?: string,
  ) => Effect.Effect<EngineJwtClaims, EngineTokenError>;
}

const KEY_ENCRYPTION_INFO = Buffer.from("metamorph-engine-jwt-key-v1", "utf8");

function deriveAesKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), KEY_ENCRYPTION_INFO, 32),
  );
}

function encryptPrivateKeyPem(pem: string, secret: string): string {
  const key = deriveAesKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

function decryptPrivateKeyPem(payload: string, secret: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Malformed encrypted engine signing key payload");
  }
  const key = deriveAesKey(secret);
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function derivePublicSpkiFromPkcs8(pkcs8Pem: string): string {
  const priv = createPrivateKey(pkcs8Pem);
  const pub = createPublicKey(priv);
  return pub.export({ type: "spki", format: "pem" });
}

function parseDurationSeconds(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)\s*([smhd])?$/.exec(trimmed);
  if (!match || !match[1]) return 900;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "s";
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 3600;
  if (unit === "d") return value * 86400;
  return value;
}

const generateEd25519KeyMaterial = Effect.fnUntraced(function* (
  signature: Signature.Signature["Service"],
  kid: string,
) {
  const keyPair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA", kid }).pipe(
    Effect.provideService(Signature.Signature, signature),
  );
  const privateKey = yield* Jwk.importPrivate(keyPair.privateKey, "EdDSA");
  const publicKey = yield* Jwk.importPublic(keyPair.publicKey, "EdDSA");
  const publicJwk = yield* Jwk.exportPublic(publicKey);
  return { privateKey, publicKey, publicJwk };
});

const makeEngineTokenShape = (params: {
  readonly kid: string;
  readonly issuer: string;
  readonly defaultTtlSeconds: number;
  readonly privateKey: Jwk.PrivateKey;
  readonly publicKey: Jwk.PublicKey;
  readonly publicKeyPem: string;
  readonly publicJwk: Jwk.PublicJwk;
  readonly signature: Signature.Signature["Service"];
}): EngineTokenServiceShape => {
  const mintSessionToken: EngineTokenServiceShape["mintSessionToken"] = Effect.fn(
    "EngineTokenService.mintSessionToken",
  )(function* (input: MintSessionTokenInput) {
    const ttl = Math.max(60, Math.min(input.ttlSeconds ?? params.defaultTtlSeconds, 3600));
    const nowMs = yield* Clock.currentTimeMillis;
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + ttl;
    const jti = SecureRandom.uuidV4Unsafe();

    const redacted = yield* Jwt.sign(
      EngineJwtClaims,
      {
        sub: input.userId,
        aud: input.instanceId,
        iss: params.issuer,
        iat,
        exp,
        jti,
        modalities: [...input.modalities],
      },
      params.privateKey,
      { kid: params.kid, typ: "JWT" },
    ).pipe(
      Effect.provideService(Signature.Signature, params.signature),
      Effect.mapError(
        (cause) =>
          new EngineTokenError({
            message: `Failed to sign engine session JWT: ${cause.message}`,
            cause,
          }),
      ),
    );

    return {
      token: Redacted.value(redacted),
      expiresAt: new Date(exp * 1000).toISOString(),
      instanceId: input.instanceId,
      modalities: [...input.modalities],
    };
  });

  const verifySessionToken: EngineTokenServiceShape["verifySessionToken"] = Effect.fn(
    "EngineTokenService.verifySessionToken",
  )(function* (token: string, expectedInstanceId?: string) {
    const verified = yield* Jwt.verify(EngineJwtClaims, token, params.publicKey, {
      issuer: params.issuer,
      ...(expectedInstanceId ? { audience: expectedInstanceId } : {}),
      clockTolerance: "10 seconds",
      requiredClaims: ["sub", "aud", "exp"],
    }).pipe(
      Effect.provideService(Signature.Signature, params.signature),
      Effect.mapError(
        (cause) =>
          new EngineTokenError({
            message: `Invalid engine session JWT: ${cause.message}`,
            cause,
          }),
      ),
    );
    return verified.claims;
  });

  return {
    kid: params.kid,
    issuer: params.issuer,
    publicKeyPem: params.publicKeyPem,
    publicJwks: { keys: [params.publicJwk] },
    mintSessionToken,
    verifySessionToken,
  };
};

export class EngineTokenService extends Context.Service<
  EngineTokenService,
  EngineTokenServiceShape
>()("@metamorph/api/services/EngineTokenService") {
  /** In-memory ephemeral Ed25519 keypair layer for offline tests without a database. */
  static readonly layerEphemeral = (options?: {
    readonly issuer?: string | undefined;
    readonly defaultTtlSeconds?: number | undefined;
    readonly kid?: string | undefined;
  }) =>
    Layer.effect(
      EngineTokenService,
      Effect.gen(function* () {
        const signature = yield* Signature.Signature;
        const kid = options?.kid ?? "test-engine-key";
        const issuer = options?.issuer ?? "http://localhost:3001";
        const defaultTtlSeconds = options?.defaultTtlSeconds ?? 900;

        const { privateKey, publicKey, publicJwk } = yield* generateEd25519KeyMaterial(
          signature,
          kid,
        );
        const publicKeyPem = yield* Jwk.exportSpki(publicKey, { format: "pem" });

        return EngineTokenService.of(
          makeEngineTokenShape({
            kid,
            issuer,
            defaultTtlSeconds,
            privateKey,
            publicKey,
            publicKeyPem,
            publicJwk,
            signature,
          }),
        );
      }),
    );

  /**
   * Production layer: loads `ENGINE_JWT_PRIVATE_KEY` (PKCS#8 PEM) if configured,
   * otherwise loads or generates an encrypted Ed25519 keypair in `engine_signing_key`.
   */
  static readonly layer = Layer.effect(
    EngineTokenService,
    Effect.gen(function* () {
      const db = yield* Database;
      const signature = yield* Signature.Signature;

      const baseUrl = yield* Config.String("BETTER_AUTH_URL").pipe(
        Config.withDefault("http://localhost:3001"),
      );
      const issuerOpt = yield* Config.option(Config.String("JWT_ISSUER"));
      const issuer = Option.match(issuerOpt, {
        onNone: () => baseUrl,
        onSome: (v) => (v.trim() === "" ? baseUrl : v.trim()),
      });
      const expOpt = yield* Config.String("JWT_EXPIRATION_TIME").pipe(Config.withDefault("15m"));
      const defaultTtlSeconds = parseDurationSeconds(expOpt);

      const envPrivateKeyOpt = yield* Config.option(Config.Redacted("ENGINE_JWT_PRIVATE_KEY"));
      const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET");

      if (Option.isSome(envPrivateKeyOpt) && Redacted.value(envPrivateKeyOpt.value).trim() !== "") {
        const rawPem = Redacted.value(envPrivateKeyOpt.value).replace(/\\n/g, "\n").trim();
        const kid = "env-ed25519";
        const privateKey = yield* Jwk.importPkcs8(Redacted.make(rawPem), "EdDSA", { kid });
        const spkiPem = derivePublicSpkiFromPkcs8(rawPem);
        const publicKey = yield* Jwk.importSpki(spkiPem, "EdDSA", { kid });
        const publicJwk = yield* Jwk.exportPublic(publicKey);

        return EngineTokenService.of(
          makeEngineTokenShape({
            kid,
            issuer,
            defaultTtlSeconds,
            privateKey,
            publicKey,
            publicKeyPem: spkiPem,
            publicJwk,
            signature,
          }),
        );
      }

      const secretValue = Redacted.value(authSecret);
      const existingRows = yield* db
        .select()
        .from(engineSigningKey)
        .where(eq(engineSigningKey.id, "primary"))
        .limit(1);

      const existing = existingRows[0];
      if (existing) {
        const decryptedPem = decryptPrivateKeyPem(existing.encryptedPrivateKey, secretValue);
        const privateKey = yield* Jwk.importPkcs8(Redacted.make(decryptedPem), "EdDSA", {
          kid: existing.id,
        });
        const publicKey = yield* Jwk.importSpki(existing.publicKeyPem, "EdDSA", {
          kid: existing.id,
        });
        const publicJwk = yield* Jwk.exportPublic(publicKey);

        return EngineTokenService.of(
          makeEngineTokenShape({
            kid: existing.id,
            issuer,
            defaultTtlSeconds,
            privateKey,
            publicKey,
            publicKeyPem: existing.publicKeyPem,
            publicJwk,
            signature,
          }),
        );
      }

      const kid = "primary";
      const { privateKey, publicKey, publicJwk } = yield* generateEd25519KeyMaterial(
        signature,
        kid,
      );
      const pkcs8Pem = yield* Jwk.exportPkcs8(privateKey, { format: "pem" });
      const spkiPem = yield* Jwk.exportSpki(publicKey, { format: "pem" });
      const encryptedPrivateKey = encryptPrivateKeyPem(Redacted.value(pkcs8Pem), secretValue);

      yield* db
        .insert(engineSigningKey)
        .values({
          id: kid,
          publicKeyPem: spkiPem,
          publicKeyJwk: publicJwk as Record<string, unknown>,
          encryptedPrivateKey,
        })
        .onConflictDoNothing();

      // Re-read in case another process raced on initial boot
      const finalRows = yield* db
        .select()
        .from(engineSigningKey)
        .where(eq(engineSigningKey.id, kid))
        .limit(1);
      const row = finalRows[0];
      if (row) {
        const decrypted = decryptPrivateKeyPem(row.encryptedPrivateKey, secretValue);
        const finalPriv = yield* Jwk.importPkcs8(Redacted.make(decrypted), "EdDSA", {
          kid: row.id,
        });
        const finalPub = yield* Jwk.importSpki(row.publicKeyPem, "EdDSA", { kid: row.id });
        const finalJwk = yield* Jwk.exportPublic(finalPub);
        return EngineTokenService.of(
          makeEngineTokenShape({
            kid: row.id,
            issuer,
            defaultTtlSeconds,
            privateKey: finalPriv,
            publicKey: finalPub,
            publicKeyPem: row.publicKeyPem,
            publicJwk: finalJwk,
            signature,
          }),
        );
      }

      return EngineTokenService.of(
        makeEngineTokenShape({
          kid,
          issuer,
          defaultTtlSeconds,
          privateKey,
          publicKey,
          publicKeyPem: spkiPem,
          publicJwk,
          signature,
        }),
      );
    }),
  );
}
